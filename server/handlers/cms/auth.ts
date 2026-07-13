/**
 * Auth routes — Logto OIDC (the builder is the OIDC client).
 *
 *   GET /admin/api/cms/auth/login    — begin sign-in: mint PKCE/state/nonce,
 *                                       stash them in a short-lived tx cookie,
 *                                       redirect to Logto's authorize endpoint.
 *   GET /admin/api/cms/auth/callback  — Logto redirects here with a code: verify
 *                                       state, exchange the code, verify the ID
 *                                       token, auto-provision the local identity,
 *                                       mint the session cookie, land on /admin/site.
 *   GET /admin/api/cms/auth/logout    — revoke the session, clear the cookie, and
 *                                       redirect to Logto's end-session endpoint.
 *   GET /admin/api/cms/me             — the authenticated identity + capabilities.
 *
 * Per-request auth never contacts Logto again: after the callback, the opaque
 * session cookie (validated against the local `sessions` table) is the source
 * of truth, exactly as before. Only the *login* step changed.
 *
 * Dispatch shape: a flat `AUTH_ROUTES` table maps `(method, pattern)` to a
 * handler; `runRouteTable` handles 404-vs-405. Adding a route is "new handler
 * function + one row in `AUTH_ROUTES`".
 */
import type { DbClient } from '../../db/client'
import { createSessionToken, hashSessionToken, sessionExpiry } from '../../auth/tokens'
import { createSession, revokeSessionByHash } from '../../auth/sessions'
import { getSessionHash, requireAuthenticatedUser } from '../../auth/authz'
import { toPublicUser } from '../../repositories/users'
import { createAuditEvent } from '../../repositories/audit'
import { publicOriginIsHttps } from '../../auth/security'
import {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  createPkcePair,
  exchangeCodeForTokens,
  randomUrlToken,
  readLogtoConfig,
  verifyIdToken,
  type LogtoConfig,
} from '../../auth/oidc'
import { extractLogtoClaims, provisionUserFromClaims } from '../../auth/logtoIdentity'
import { resolvePublicOrigins } from '../../config'
import { jsonResponse, setCookieHeader } from '../../http'
import { CMS_API_PREFIX, requestAuditContext } from './shared'
import { clearSessionCookie, sessionCookie } from './session'
import { runRouteTable, type Route } from './routeTable'

const OIDC_TX_COOKIE = 'instatic_oidc_tx'
const OIDC_TX_MAX_AGE_SECONDS = 600

interface OidcTransaction {
  state: string
  nonce: string
  codeVerifier: string
}

function loadLogtoConfig(): LogtoConfig | null {
  return readLogtoConfig(process.env, resolvePublicOrigins(process.env))
}

function logtoNotConfigured(): Response {
  return jsonResponse(
    { error: 'Logto is not configured. Set LOGTO_ENDPOINT, LOGTO_APP_ID and LOGTO_APP_SECRET.' },
    { status: 500 },
  )
}

function isSecureRequest(req: Request): boolean {
  return publicOriginIsHttps() || req.url.startsWith('https://')
}

function txCookie(req: Request, value: string, maxAgeSeconds: number): string {
  const base = `${OIDC_TX_COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Lax`
  const secured = isSecureRequest(req) ? `${base}; Secure` : base
  return `${secured}; Max-Age=${maxAgeSeconds}`
}

function readTxCookie(req: Request): OidcTransaction | null {
  const cookie = req.headers.get('cookie') ?? ''
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key !== OIDC_TX_COOKIE) continue
    try {
      const decoded = Buffer.from(rest.join('='), 'base64url').toString('utf8')
      const parsed = JSON.parse(decoded)
      if (
        parsed && typeof parsed.state === 'string' &&
        typeof parsed.nonce === 'string' && typeof parsed.codeVerifier === 'string'
      ) {
        return { state: parsed.state, nonce: parsed.nonce, codeVerifier: parsed.codeVerifier }
      }
    } catch {
      return null
    }
  }
  return null
}

function redirect(location: string, cookies: string[] = []): Response {
  const res = new Response(null, { status: 302, headers: { location } })
  for (const cookie of cookies) res.headers.append('set-cookie', cookie)
  return res
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleLogin(req: Request, _db: DbClient): Promise<Response> {
  const config = loadLogtoConfig()
  if (!config) return logtoNotConfigured()

  const state = randomUrlToken()
  const nonce = randomUrlToken()
  const { verifier, challenge } = createPkcePair()
  const tx: OidcTransaction = { state, nonce, codeVerifier: verifier }
  const encoded = Buffer.from(JSON.stringify(tx), 'utf8').toString('base64url')

  const authorizeUrl = buildAuthorizeUrl(config, { state, nonce, codeChallenge: challenge })
  return redirect(authorizeUrl, [txCookie(req, encoded, OIDC_TX_MAX_AGE_SECONDS)])
}

async function handleCallback(req: Request, db: DbClient): Promise<Response> {
  const config = loadLogtoConfig()
  if (!config) return logtoNotConfigured()

  const url = new URL(req.url)
  const error = url.searchParams.get('error')
  if (error) {
    return jsonResponse({ error: `Logto sign-in failed: ${error}` }, { status: 401 })
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const tx = readTxCookie(req)
  const clearTx = txCookie(req, '', 0)

  if (!code || !state || !tx || tx.state !== state) {
    return setCookieHeader(
      jsonResponse({ error: 'Invalid sign-in state' }, { status: 400 }),
      clearTx,
    )
  }

  let userId: string
  let auditActorId: string
  try {
    const tokens = await exchangeCodeForTokens(config, code, tx.codeVerifier)
    const payload = await verifyIdToken(config, tokens.id_token, tx.nonce)
    const claims = extractLogtoClaims(payload)
    const user = await provisionUserFromClaims(db, claims)
    userId = user.id
    auditActorId = user.id
  } catch (err) {
    console.error('[auth:callback]', err)
    return setCookieHeader(
      jsonResponse({ error: 'Sign-in could not be completed' }, { status: 401 }),
      clearTx,
    )
  }

  const token = createSessionToken()
  const expiresAt = sessionExpiry()
  await createSession(db, {
    idHash: await hashSessionToken(token),
    userId,
    expiresAt,
    ...requestAuditContext(req),
  })
  await createAuditEvent(db, {
    actorUserId: auditActorId,
    action: 'login.success',
    targetType: 'user',
    targetId: auditActorId,
    metadata: {},
    ...requestAuditContext(req),
  })

  const res = redirect('/admin/site', [sessionCookie(req, token, expiresAt), clearTx])
  return res
}

async function handleLogout(req: Request, db: DbClient): Promise<Response> {
  const user = await requireAuthenticatedUser(req, db)
  const idHash = await getSessionHash(req)
  if (idHash) await revokeSessionByHash(db, idHash)
  if (!(user instanceof Response)) {
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'logout',
      targetType: 'user',
      targetId: user.id,
      metadata: {},
      ...requestAuditContext(req),
    })
  }
  const config = loadLogtoConfig()
  const destination = config ? buildEndSessionUrl(config) : '/admin'
  return redirect(destination, [clearSessionCookie(req)])
}

async function handleMe(req: Request, db: DbClient): Promise<Response> {
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  return jsonResponse({ user: toPublicUser(user), role: user.role, capabilities: user.capabilities })
}

const AUTH_ROUTES: readonly Route<[]>[] = [
  { method: 'GET', pattern: `${CMS_API_PREFIX}/auth/login`, handler: handleLogin },
  { method: 'GET', pattern: `${CMS_API_PREFIX}/auth/callback`, handler: handleCallback },
  { method: 'GET', pattern: `${CMS_API_PREFIX}/auth/logout`, handler: handleLogout },
  { method: 'GET', pattern: `${CMS_API_PREFIX}/me`, handler: handleMe },
]

export async function handleAuthRoutes(req: Request, db: DbClient): Promise<Response | null> {
  return runRouteTable(req, db, AUTH_ROUTES)
}

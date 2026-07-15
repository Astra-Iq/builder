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
import { Type } from '@sinclair/typebox'
import type { DbClient } from '../../db/client'
import { createSessionToken, hashSessionToken, sessionExpiry } from '../../auth/tokens'
import { createSession, revokeSessionByHash, setSessionCurrentSite } from '../../auth/sessions'
import { getSessionHash, requireAuthenticatedUser } from '../../auth/authz'
import { toPublicUser } from '../../repositories/users'
import { ensureSiteForOrg, listSitesForUser } from '../../repositories/sites'
import { getSiteMemberRoleId, upsertSiteMember } from '../../repositories/siteMembers'
import { createAuditEvent } from '../../repositories/audit'
import { publicOriginIsHttps } from '../../auth/security'
import { siteLiveOrigin } from '../../publish/requestSite'
import {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  createPkcePair,
  exchangeCodeForTokens,
  fetchUserinfo,
  randomUrlToken,
  readLogtoConfig,
  verifyIdToken,
  type LogtoConfig,
} from '../../auth/oidc'
import { eligibleOrgs, extractLogtoClaims, provisionUserFromClaims } from '../../auth/logtoIdentity'
import { ensureSiteHasHomePage } from '../../bootstrapSite'
import { resolvePublicOrigins } from '../../config'
import { jsonResponse, readValidatedBody, setCookieHeader } from '../../http'
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
  let currentSiteId: string | null
  try {
    const tokens = await exchangeCodeForTokens(config, code, tx.codeVerifier)
    const payload = await verifyIdToken(config, tokens.id_token, tx.nonce)
    // Logto serves org membership + roles from userinfo, not the ID token; fall
    // back to ID-token claims only if userinfo is briefly unavailable.
    let userinfo: Record<string, unknown> = {}
    try {
      userinfo = await fetchUserinfo(config, tokens.access_token)
    } catch (err) {
      console.error('[auth:callback] userinfo fetch failed', err)
    }
    const claims = extractLogtoClaims({ ...payload, ...userinfo })
    const user = await provisionUserFromClaims(db, claims)
    userId = user.id

    // Sync every org where the user is Owner/Admin into a site + membership,
    // and make sure each site has a starter homepage to open (a freshly
    // provisioned org site otherwise has no content — an empty editor).
    const eligible = eligibleOrgs(claims)
    let firstSiteId: string | null = null
    for (const org of eligible) {
      const siteId = await ensureSiteForOrg(db, { orgId: org.orgId, name: org.name })
      await upsertSiteMember(db, { siteId, userId, roleId: org.builderRoleId })
      await ensureSiteHasHomePage(db, siteId)
      if (firstSiteId === null) firstSiteId = siteId
    }
    // One eligible org → enter it directly; zero or many → no current site yet
    // (the admin shell shows the "access unavailable" screen or the org picker).
    currentSiteId = eligible.length === 1 ? firstSiteId : null
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
    currentSiteId,
    ...requestAuditContext(req),
  })
  await createAuditEvent(db, {
    actorUserId: userId,
    action: 'login.success',
    targetType: 'user',
    targetId: userId,
    metadata: {},
    ...requestAuditContext(req),
  })

  const destination = currentSiteId ? '/admin/site' : '/admin'
  return redirect(destination, [sessionCookie(req, token, expiresAt), clearTx])
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
  // The sites the user may edit (empty => "access unavailable") and the one the
  // session is currently on (null => the admin shell shows the org picker).
  const memberships = await listSitesForUser(db, user.id)
  const availableSites = memberships.map((site) => ({
    id: site.id,
    name: site.name,
    slug: site.slug,
    roleId: site.roleId,
    liveOrigin: siteLiveOrigin(site),
  }))
  const currentSite = user.currentSiteId
    ? availableSites.find((site) => site.id === user.currentSiteId) ?? null
    : null
  return jsonResponse({
    user: toPublicUser(user),
    role: user.role,
    capabilities: user.capabilities,
    currentSite,
    availableSites,
  })
}

const SwitchSiteSchema = Type.Object({ siteId: Type.String({ minLength: 1 }) })

/** Point the current session at another site the user is a member of. */
async function handleSwitchSite(req: Request, db: DbClient): Promise<Response> {
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  const body = await readValidatedBody(req, SwitchSiteSchema)
  if (!body) return jsonResponse({ error: 'Invalid request' }, { status: 400 })

  const roleId = await getSiteMemberRoleId(db, body.siteId, user.id)
  if (!roleId) {
    return jsonResponse({ error: 'You are not a member of that site' }, { status: 403 })
  }
  const idHash = await getSessionHash(req)
  if (!idHash) return jsonResponse({ error: 'No active session' }, { status: 401 })
  await setSessionCurrentSite(db, idHash, body.siteId)
  return jsonResponse({ ok: true, siteId: body.siteId })
}

const AUTH_ROUTES: readonly Route<[]>[] = [
  { method: 'GET', pattern: `${CMS_API_PREFIX}/auth/login`, handler: handleLogin },
  { method: 'GET', pattern: `${CMS_API_PREFIX}/auth/callback`, handler: handleCallback },
  { method: 'GET', pattern: `${CMS_API_PREFIX}/auth/logout`, handler: handleLogout },
  { method: 'GET', pattern: `${CMS_API_PREFIX}/me`, handler: handleMe },
  { method: 'POST', pattern: `${CMS_API_PREFIX}/session/switch-site`, handler: handleSwitchSite },
]

export async function handleAuthRoutes(req: Request, db: DbClient): Promise<Response | null> {
  return runRouteTable(req, db, AUTH_ROUTES)
}

/**
 * Logto OIDC client — the builder acts as a confidential OIDC client.
 *
 * The builder redirects unauthenticated users to Logto's authorization
 * endpoint, receives an authorization code at its callback, exchanges it for
 * tokens, and verifies the ID token against Logto's JWKS. The verified claims
 * (subject, email, name, picture, roles) drive local user provisioning and the
 * role → capability mapping (`logtoIdentity.ts`); the builder then mints its
 * own opaque session cookie (the existing `sessions` machinery), so per-request
 * auth never re-contacts Logto.
 *
 * No Logto SDK: the OIDC endpoints follow the standard shape under
 * `${LOGTO_ENDPOINT}/oidc`, and `jose` handles JWKS + JWT verification. This
 * matches the repo's "implement the protocol directly" stance.
 *
 * Config is resolved lazily (`readLogtoConfig`) and is OPTIONAL at boot: the
 * server starts without the `LOGTO_*` env vars so tests and tooling boot
 * normally; the auth routes return a clear 500 when Logto is not configured.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { createHash, randomBytes } from 'node:crypto'

const REQUIRED_LOGTO_SCOPES = [
  'openid',
  'profile',
  'email',
  'roles',
  'urn:logto:scope:organizations',
  'urn:logto:scope:organization_roles',
] as const

export interface LogtoConfig {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
  endSessionEndpoint: string
  appId: string
  appSecret: string
  /** Absolute callback URL registered with the Logto application. */
  redirectUri: string
  /** Absolute URL Logto returns to after RP-initiated logout. */
  postLogoutRedirectUri: string
  scopes: string
}

function normalizeScopes(value: string | undefined): string {
  const scopes = new Set(value?.trim().split(/\s+/).filter(Boolean) ?? [])
  for (const scope of REQUIRED_LOGTO_SCOPES) scopes.add(scope)
  return [...scopes].join(' ')
}

/**
 * Resolve the Logto OIDC config from env, deriving the redirect URIs from the
 * first configured public origin when not set explicitly. Returns `null` when
 * the install has no Logto configured (missing endpoint / app id / secret, or
 * no absolute base for the redirect URIs) — callers surface a 500.
 */
export function readLogtoConfig(
  env: Record<string, string | undefined> = process.env,
  publicOrigins: readonly string[] = [],
): LogtoConfig | null {
  const endpoint = env.LOGTO_ENDPOINT?.trim().replace(/\/+$/, '')
  const appId = env.LOGTO_APP_ID?.trim()
  const appSecret = env.LOGTO_APP_SECRET?.trim()
  if (!endpoint || !appId || !appSecret) return null

  const base = (publicOrigins[0] ?? '').replace(/\/+$/, '')
  const redirectUri = env.LOGTO_REDIRECT_URI?.trim() || (base ? `${base}/admin/api/cms/auth/callback` : '')
  const postLogoutRedirectUri =
    env.LOGTO_POST_LOGOUT_REDIRECT_URI?.trim() || (base ? `${base}/admin` : '')
  // The redirect URI must be absolute and match what's registered in Logto.
  // Without a public origin (or an explicit override) we can't form one.
  if (!redirectUri.startsWith('http')) return null

  return {
    issuer: `${endpoint}/oidc`,
    authorizationEndpoint: `${endpoint}/oidc/auth`,
    tokenEndpoint: `${endpoint}/oidc/token`,
    jwksUri: `${endpoint}/oidc/jwks`,
    endSessionEndpoint: `${endpoint}/oidc/session/end`,
    appId,
    appSecret,
    redirectUri,
    postLogoutRedirectUri,
    scopes: normalizeScopes(env.LOGTO_SCOPES),
  }
}

// ---------------------------------------------------------------------------
// PKCE + transaction values
// ---------------------------------------------------------------------------

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function randomUrlToken(bytes = 16): string {
  return randomBytes(bytes).toString('base64url')
}

// ---------------------------------------------------------------------------
// Authorization redirect
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(
  config: LogtoConfig,
  input: { state: string; nonce: string; codeChallenge: string },
): string {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scopes,
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  })
  return `${config.authorizationEndpoint}?${params.toString()}`
}

export function buildEndSessionUrl(config: LogtoConfig, idTokenHint?: string): string {
  const params = new URLSearchParams({
    client_id: config.appId,
    post_logout_redirect_uri: config.postLogoutRedirectUri,
  })
  if (idTokenHint) params.set('id_token_hint', idTokenHint)
  return `${config.endSessionEndpoint}?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Token exchange + verification
// ---------------------------------------------------------------------------

interface TokenResponse {
  id_token: string
  access_token: string
  token_type: string
  expires_in?: number
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OidcError'
  }
}

/**
 * Exchange an authorization code for tokens at Logto's token endpoint using
 * PKCE + HTTP Basic client authentication (`client_secret_basic`).
 */
export async function exchangeCodeForTokens(
  config: LogtoConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  })
  const basic = Buffer.from(`${config.appId}:${config.appSecret}`).toString('base64')
  const res = await fetchImpl(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  })
  if (!res.ok) {
    throw new OidcError(`Token exchange failed (${res.status})`)
  }
  const json = (await res.json()) as Partial<TokenResponse>
  if (!json.id_token || !json.access_token) {
    throw new OidcError('Token response missing id_token/access_token')
  }
  return json as TokenResponse
}

// Cache one JWKS resolver per jwks URI. `createRemoteJWKSet` handles fetching +
// key-rotation caching internally.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function jwksForConfig(config: LogtoConfig): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(config.jwksUri)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(config.jwksUri))
    jwksCache.set(config.jwksUri, jwks)
  }
  return jwks
}

/**
 * Verify a Logto ID token against the tenant JWKS, checking issuer, audience
 * (the app id) and expiry, then assert the `nonce` matches the value bound to
 * the login transaction. Returns the verified claims.
 *
 * `jwksResolver` is injectable so unit tests can verify against a locally
 * generated key pair without a network JWKS fetch.
 */
export async function verifyIdToken(
  config: LogtoConfig,
  idToken: string,
  expectedNonce: string,
  jwksResolver: Parameters<typeof jwtVerify>[1] = jwksForConfig(config),
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(idToken, jwksResolver, {
    issuer: config.issuer,
    audience: config.appId,
  })
  if (payload.nonce !== expectedNonce) {
    throw new OidcError('ID token nonce mismatch')
  }
  return payload
}

/**
 * Fetch the OIDC userinfo document (`${issuer}/me`) with the access token.
 * Logto serves the organization membership + org-role claims here (they are not
 * reliably present in the ID token), so the callback reads roles/orgs from this
 * response. Throws `OidcError` on a non-2xx response.
 */
export async function fetchUserinfo(
  config: LogtoConfig,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${config.issuer}/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    throw new OidcError(`Userinfo request failed (${res.status})`)
  }
  return (await res.json()) as Record<string, unknown>
}

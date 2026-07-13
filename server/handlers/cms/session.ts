/**
 * Session cookie helpers.
 *
 * `sessionCookie` / `clearSessionCookie` build the `Set-Cookie` headers used by
 * the auth handlers (the OIDC callback + logout). They set the `Secure` flag
 * from the configured public origin (so cookies are reliably Secure on managed
 * HTTPS platforms that terminate TLS at the edge) and fall back to the request
 * URL's scheme for direct connections.
 */
import { SESSION_COOKIE_NAME } from '../../auth/tokens'
import { publicOriginIsHttps } from '../../auth/security'

/**
 * True when the inbound request was made over HTTPS.
 *
 * When a public origin is configured (the managed-platform / reverse-proxy
 * case), that origin's scheme is authoritative — so the `Secure` flag is set
 * even though a TLS-terminating edge hands the container plain HTTP, and no
 * untrusted `X-Forwarded-Proto` header is consulted. Falls back to the request
 * URL's protocol for direct connections.
 */
function requestIsHttps(req: Request): boolean {
  if (publicOriginIsHttps()) return true
  return req.url.startsWith('https://')
}

function sessionCookieAttributes(secure: boolean): string {
  // HttpOnly  — JS in the browser cannot read the cookie (XSS mitigation)
  // SameSite=Lax — cross-origin POST/PUT/DELETE don't carry the cookie (CSRF)
  // Secure    — browser only sends the cookie over HTTPS (set when applicable)
  const base = 'Path=/admin; HttpOnly; SameSite=Lax'
  return secure ? `${base}; Secure` : base
}

export function sessionCookie(req: Request, token: string, expires: Date): string {
  const attrs = sessionCookieAttributes(requestIsHttps(req))
  return `${SESSION_COOKIE_NAME}=${token}; ${attrs}; Expires=${expires.toUTCString()}`
}

export function clearSessionCookie(req: Request): string {
  const attrs = sessionCookieAttributes(requestIsHttps(req))
  return `${SESSION_COOKIE_NAME}=; ${attrs}; Max-Age=0`
}

import type { DbClient } from '../db/client'
import { SESSION_COOKIE_NAME, hashSessionToken } from './tokens'
import { roleHasCapability, type CoreCapability } from './capabilities'
import { findUserBySessionHash } from './sessions'
import { jsonResponse } from '../http'
import type { AuthUser } from '../repositories/users'

function readCookie(req: Request, name: string): string {
  const cookie = req.headers.get('cookie') ?? ''
  for (const part of cookie.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=')
    if (rawKey === name) return rawValue.join('=')
  }
  return ''
}

/**
 * Hash of the request's session cookie, or `null` when no session cookie is
 * present. Returning `null` (rather than an empty string) keeps "no
 * identifiable session" distinct from a real hash — critical for
 * `revokeAllOtherSessions`, whose `keepSessionHash === null` path revokes
 * EVERY session. An empty-string sentinel would silently collapse into that
 * fallback.
 */
export async function getSessionHash(req: Request): Promise<string | null> {
  const token = readCookie(req, SESSION_COOKIE_NAME)
  return token ? hashSessionToken(token) : null
}

export async function requireAuthenticatedUser(
  req: Request,
  db: DbClient,
): Promise<AuthUser | Response> {
  const idHash = await getSessionHash(req)
  const user = idHash ? await findUserBySessionHash(db, idHash) : null
  if (!user) {
    return jsonResponse({ error: 'Unauthorized' }, { status: 401 })
  }
  return user
}

export async function requireCapability(
  req: Request,
  db: DbClient,
  capability: CoreCapability,
): Promise<AuthUser | Response> {
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  if (!userHasCapability(user, capability)) {
    return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  }
  return user
}

export function userHasCapability(user: Pick<AuthUser, 'capabilities'>, capability: CoreCapability): boolean {
  return roleHasCapability(user.capabilities, capability)
}

export function userHasAnyCapability(
  user: Pick<AuthUser, 'capabilities'>,
  capabilities: readonly CoreCapability[],
): boolean {
  return capabilities.some((capability) => userHasCapability(user, capability))
}

export async function requireAnyCapability(
  req: Request,
  db: DbClient,
  capabilities: readonly CoreCapability[],
): Promise<AuthUser | Response> {
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  if (!userHasAnyCapability(user, capabilities)) {
    return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  }
  return user
}

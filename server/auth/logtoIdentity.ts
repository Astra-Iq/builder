/**
 * Logto identity → builder identity.
 *
 * Turns verified Logto ID-token claims into a local `AuthUser`:
 *   1. Map the user's Logto role(s) onto one of the builder's four roles
 *      (`owner` / `admin` / `client` / `member`) — the capability set for that
 *      role lives, unchanged, in `SYSTEM_ROLES` (`server/auth/capabilities.ts`)
 *      and flows through the existing `roles.capabilities_json → AuthUser`
 *      hydration.
 *   2. Auto-provision (upsert) a local `users` row keyed by the Logto subject,
 *      so content authorship, audit actor, and the `sessions.user_id` FK keep
 *      referencing a real local id. Logto owns the credential; the local row is
 *      just the identity shadow.
 *
 * Logto exposes the user's roles in the `roles` claim when the `roles` scope is
 * granted (configure the Logto app to include it in the ID token).
 */
import type { JWTPayload } from 'jose'
import type { DbClient } from '../db/client'
import { SYSTEM_ROLES } from './capabilities'
import { findUserById, upsertUserByLogtoSubject, type AuthUser } from '../repositories/users'

export interface LogtoClaims {
  subject: string
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  roles: string[]
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Extract the claims the builder cares about from a verified ID-token payload. */
export function extractLogtoClaims(payload: JWTPayload): LogtoClaims {
  return {
    subject: String(payload.sub ?? ''),
    email: asString(payload.email),
    displayName: asString(payload.name) ?? asString(payload.username),
    avatarUrl: asString(payload.picture),
    roles: asStringArray(payload.roles),
  }
}

/**
 * Map Logto role names onto a builder role id. Iterates `SYSTEM_ROLES` in
 * privilege order (owner → admin → client → member) and returns the id of the
 * first role whose slug matches one of the user's Logto roles (case-insensitive).
 * Falls back to `member` (no capabilities) when nothing matches.
 */
export function mapLogtoRoleToBuilderRole(roles: readonly string[]): string {
  const wanted = new Set(roles.map((role) => role.trim().toLowerCase()))
  for (const role of SYSTEM_ROLES) {
    if (wanted.has(role.slug.toLowerCase()) || wanted.has(role.id.toLowerCase())) {
      return role.id
    }
  }
  return 'member'
}

/**
 * Upsert the local identity for a set of Logto claims and return the hydrated
 * `AuthUser` (capabilities included). The role is re-synced on every login so a
 * role change in Logto takes effect on the user's next sign-in.
 */
export async function provisionUserFromClaims(
  db: DbClient,
  claims: LogtoClaims,
): Promise<AuthUser> {
  if (!claims.subject) {
    throw new Error('Logto claims missing subject')
  }
  const roleId = mapLogtoRoleToBuilderRole(claims.roles)
  const userId = await upsertUserByLogtoSubject(db, {
    subject: claims.subject,
    email: claims.email ?? `${claims.subject}@logto.local`,
    displayName: claims.displayName ?? claims.email ?? claims.subject,
    roleId,
  })
  const user = await findUserById(db, userId)
  if (!user) throw new Error('Provisioned user could not be loaded')
  return user
}

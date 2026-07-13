/**
 * Logto identity → builder identity (organization-scoped).
 *
 * A Logto **Organization** maps 1:1 to a builder **site**. On sign-in the
 * callback:
 *   1. Reads the user's organization memberships + org roles from the Logto
 *      userinfo claims (`organization_data` + `organization_roles`).
 *   2. Keeps only the orgs where the user is **Owner or Admin** (Viewer and
 *      non-members are denied entry) and maps each to a builder role id
 *      (`owner` / `admin`) whose capability set lives in `SYSTEM_ROLES`.
 *   3. Auto-provisions a local `users` row keyed by the Logto subject (so
 *      authorship / audit / session FKs resolve). The user's **global**
 *      `role_id` is a no-capability `member` baseline — real authorization is
 *      per-site, resolved from `site_members(current_site_id)` at request time.
 *
 * The per-org site + membership rows are written by the callback via
 * `ensureSiteForOrg` + `upsertSiteMember`; this module owns claim parsing and
 * the role mapping.
 */
import type { DbClient } from '../db/client'
import { findUserById, upsertUserByLogtoSubject, type AuthUser } from '../repositories/users'

/** Global baseline role for a Logto-provisioned identity: no capabilities. */
const GLOBAL_BASELINE_ROLE_ID = 'member'

export interface OrgMembership {
  id: string
  name: string
  roles: string[]
}

export interface LogtoClaims {
  subject: string
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  organizations: OrgMembership[]
}

export interface EligibleOrg {
  orgId: string
  name: string
  /** Builder role id the org role maps to (`owner` | `admin`). */
  builderRoleId: string
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Parse org membership from merged ID-token + userinfo claims. Org identity
 * comes from `organization_data: [{ id, name }]`; org roles come from
 * `organization_roles: ["<orgId>:<roleName>"]`. Tolerates either claim being
 * absent (an org with no listed role simply has no eligible builder role).
 */
function parseOrganizations(payload: Record<string, unknown>): OrgMembership[] {
  const byId = new Map<string, OrgMembership>()

  const data = payload.organization_data
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (!entry || typeof entry !== 'object') continue
      const id = asString((entry as Record<string, unknown>).id)
      if (!id) continue
      byId.set(id, { id, name: asString((entry as Record<string, unknown>).name) ?? id, roles: [] })
    }
  }

  const roleClaims = payload.organization_roles
  if (Array.isArray(roleClaims)) {
    for (const claim of roleClaims) {
      if (typeof claim !== 'string') continue
      const sep = claim.indexOf(':')
      if (sep <= 0) continue
      const orgId = claim.slice(0, sep)
      const roleName = claim.slice(sep + 1)
      const entry = byId.get(orgId) ?? { id: orgId, name: orgId, roles: [] }
      entry.roles.push(roleName)
      byId.set(orgId, entry)
    }
  }

  return [...byId.values()]
}

/** Extract the claims the builder cares about from merged ID-token + userinfo. */
export function extractLogtoClaims(payload: Record<string, unknown>): LogtoClaims {
  return {
    subject: String(payload.sub ?? ''),
    email: asString(payload.email),
    displayName: asString(payload.name) ?? asString(payload.username),
    avatarUrl: asString(payload.picture),
    organizations: parseOrganizations(payload),
  }
}

const ORG_ROLE_TO_BUILDER_ROLE: Record<string, string> = {
  owner: 'owner',
  admin: 'admin',
}

/**
 * Map a Logto organization role name onto a builder role id, or `null` when the
 * role grants no builder access (Viewer, or any unrecognized org role).
 */
export function mapOrgRoleToBuilderRole(orgRole: string): string | null {
  return ORG_ROLE_TO_BUILDER_ROLE[orgRole.trim().toLowerCase()] ?? null
}

/**
 * The organizations the user may enter the builder for: those where at least
 * one org role maps to a builder role. Each org resolves to its highest
 * privilege (Owner outranks Admin).
 */
export function eligibleOrgs(claims: LogtoClaims): EligibleOrg[] {
  const eligible: EligibleOrg[] = []
  for (const org of claims.organizations) {
    let best: string | null = null
    for (const role of org.roles) {
      const mapped = mapOrgRoleToBuilderRole(role)
      if (mapped === 'owner') {
        best = 'owner'
        break
      }
      if (mapped === 'admin') best = 'admin'
    }
    if (best) eligible.push({ orgId: org.id, name: org.name, builderRoleId: best })
  }
  return eligible
}

/**
 * Upsert the local identity for a set of Logto claims and return the hydrated
 * `AuthUser`. The global role is always the no-capability `member` baseline;
 * per-site authorization is carried by `site_members`, written by the callback.
 */
export async function provisionUserFromClaims(
  db: DbClient,
  claims: LogtoClaims,
): Promise<AuthUser> {
  if (!claims.subject) {
    throw new Error('Logto claims missing subject')
  }
  const userId = await upsertUserByLogtoSubject(db, {
    subject: claims.subject,
    email: claims.email ?? `${claims.subject}@logto.local`,
    displayName: claims.displayName ?? claims.email ?? claims.subject,
    roleId: GLOBAL_BASELINE_ROLE_ID,
  })
  const user = await findUserById(db, userId)
  if (!user) throw new Error('Provisioned user could not be loaded')
  return user
}

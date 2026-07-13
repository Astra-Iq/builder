/**
 * Site membership repository — the (user, site) → role association.
 *
 * Logto owns org membership + org roles; this table is a login-time cache
 * (`source = 'logto'`) re-synced on every sign-in. It supplies the per-site
 * role that the session-cookie hydration resolves capabilities from
 * (`server/auth/sessions.ts`), so a user's capabilities always reflect the
 * site they are currently editing — not a single global role.
 */
import type { DbClient } from '../db/client'

export async function upsertSiteMember(
  db: DbClient,
  input: { siteId: string; userId: string; roleId: string },
): Promise<void> {
  await db`
    insert into site_members (site_id, user_id, role_id, source, updated_at)
    values (${input.siteId}, ${input.userId}, ${input.roleId}, 'logto', current_timestamp)
    on conflict (site_id, user_id) do update
      set role_id = excluded.role_id,
          source = excluded.source,
          updated_at = current_timestamp
  `
}

export async function getSiteMemberRoleId(
  db: DbClient,
  siteId: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await db<{ role_id: string }>`
    select role_id from site_members
    where site_id = ${siteId} and user_id = ${userId}
    limit 1
  `
  return rows[0]?.role_id ?? null
}

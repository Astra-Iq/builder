/**
 * Sites registry repository — the multi-tenant `sites` table.
 *
 * Each row is one tenant (one Logto Organization = one site). The singleton
 * site-shell read/write still lives in `repositories/site.ts` (it owns the
 * `settings_json` document); this module owns tenant identity: the (id,
 * logto_org_id, slug, name, status) registry and its membership joins.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'

/**
 * The adopted single-install site id. Surfaces that are not yet org-aware —
 * the plugin runtime content API, headless AI/MCP content tools, and public
 * form submissions — bind their content reads/writes to this site until their
 * own multi-tenancy phase plumbs a real site context through. The `/admin`
 * editor is fully per-site and never uses this. Grep this constant to find the
 * surfaces still to make tenant-aware.
 */
export const DEFAULT_SITE_ID = 'default'

export interface SiteSummary {
  id: string
  logtoOrgId: string | null
  slug: string
  name: string
  status: string
  customDomain: string | null
}

interface SiteRegistryRow {
  id: string
  logto_org_id: string | null
  slug: string
  name: string
  status: string
  custom_domain: string | null
}

function rowToSummary(row: SiteRegistryRow): SiteSummary {
  return {
    id: row.id,
    logtoOrgId: row.logto_org_id ?? null,
    slug: row.slug,
    name: row.name,
    status: row.status,
    customDomain: row.custom_domain ?? null,
  }
}

function slugifySiteName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export async function getSiteById(db: DbClient, id: string): Promise<SiteSummary | null> {
  const { rows } = await db<SiteRegistryRow>`
    select id, logto_org_id, slug, name, status, custom_domain from sites where id = ${id} limit 1
  `
  return rows[0] ? rowToSummary(rows[0]) : null
}

export async function getSiteByLogtoOrgId(
  db: DbClient,
  logtoOrgId: string,
): Promise<SiteSummary | null> {
  const { rows } = await db<SiteRegistryRow>`
    select id, logto_org_id, slug, name, status, custom_domain
    from sites where logto_org_id = ${logtoOrgId} limit 1
  `
  return rows[0] ? rowToSummary(rows[0]) : null
}

/**
 * Resolve an active site by its slug — the subdomain half of the Host→site
 * serving resolver (`<slug>.<PUBLIC_BASE_DOMAIN>`). Only `active` sites serve.
 */
export async function getSiteBySlug(db: DbClient, slug: string): Promise<SiteSummary | null> {
  const { rows } = await db<SiteRegistryRow>`
    select id, logto_org_id, slug, name, status, custom_domain
    from sites where slug = ${slug} and status = 'active' limit 1
  `
  return rows[0] ? rowToSummary(rows[0]) : null
}

/**
 * Resolve an active site by its custom domain — the custom-domain half of the
 * Host→site serving resolver. Only `active` sites serve.
 */
export async function getSiteByCustomDomain(
  db: DbClient,
  customDomain: string,
): Promise<SiteSummary | null> {
  const { rows } = await db<SiteRegistryRow>`
    select id, logto_org_id, slug, name, status, custom_domain
    from sites where custom_domain = ${customDomain} and status = 'active' limit 1
  `
  return rows[0] ? rowToSummary(rows[0]) : null
}

/** Sites the user is a member of, with the member's role id for each. */
export async function listSitesForUser(
  db: DbClient,
  userId: string,
): Promise<Array<SiteSummary & { roleId: string }>> {
  const { rows } = await db<SiteRegistryRow & { role_id: string }>`
    select s.id, s.logto_org_id, s.slug, s.name, s.status, s.custom_domain, m.role_id
    from site_members m
    join sites s on s.id = m.site_id
    where m.user_id = ${userId}
    order by s.name asc
  `
  return rows.map((row) => ({ ...rowToSummary(row), roleId: row.role_id }))
}

/**
 * Idempotently ensure a site exists for a Logto organization and return its id.
 * On first sight the registry row is created (a generated id + a slug derived
 * from the org name); on subsequent logins the display name is kept fresh from
 * Logto. Content is NOT seeded here — the per-site editor bootstrap owns that.
 */
export async function ensureSiteForOrg(
  db: DbClient,
  input: { orgId: string; name: string },
): Promise<string> {
  const name = input.name.trim() || 'Untitled site'
  const existing = await getSiteByLogtoOrgId(db, input.orgId)
  if (existing) {
    if (existing.name !== name) {
      await db`update sites set name = ${name}, updated_at = current_timestamp where id = ${existing.id}`
    }
    return existing.id
  }

  const id = nanoid()
  const slug = `${slugifySiteName(name) || 'site'}-${id.slice(0, 6).toLowerCase()}`
  await db`
    insert into sites (id, logto_org_id, slug, name, status)
    values (${id}, ${input.orgId}, ${slug}, ${name}, 'active')
  `
  return id
}

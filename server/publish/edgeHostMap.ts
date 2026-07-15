/**
 * Edge host-map sync: keep the Cloudflare KV namespace the Worker reads in step
 * with each site's serving hostnames.
 *
 * The published bucket is keyed by the immutable `site_id`, but a visitor request
 * carries only a hostname (`<slug>.<PUBLIC_BASE_DOMAIN>` or a custom domain). The
 * Worker resolves host → siteId via KV; this module writes those entries. It runs
 * on publish, best-effort — a KV failure is logged by the caller, never fatal.
 *
 * The client is wired at boot (`configureEdgeHostMap`) from `PUBLISH_KV_*`; when
 * unconfigured every call is a no-op, so the default install pays nothing.
 */
import type { DbClient } from '../db/client'
import { getSiteById } from '../repositories/sites'
import { getPublicBaseDomain } from './requestSite'
import type { EdgeHostMapClient } from './cloudflareKv'

let client: EdgeHostMapClient | null = null

/** Wire (or clear) the edge host-map client at boot. */
export function configureEdgeHostMap(next: EdgeHostMapClient | null): void {
  client = next
}

/**
 * The hostnames a site is served under: its `<slug>.<PUBLIC_BASE_DOMAIN>`
 * subdomain (when a base domain is configured) and its custom domain (when set).
 */
function hostnamesForSite(slug: string, customDomain: string | null): string[] {
  const hosts: string[] = []
  const base = getPublicBaseDomain()
  if (base) hosts.push(`${slug}.${base}`)
  if (customDomain) hosts.push(customDomain.toLowerCase())
  return hosts
}

/**
 * Upsert `host → siteId` into the edge KV namespace for every hostname the site
 * serves under. No-op when the client is unconfigured or the site has no
 * resolvable hostname. Best-effort: the caller wraps this so a failure never
 * fails the publish.
 */
export async function syncSiteHostMappings(db: DbClient, siteId: string): Promise<void> {
  if (!client) return
  const site = await getSiteById(db, siteId)
  if (!site) return

  const hosts = hostnamesForSite(site.slug, site.customDomain)
  for (const host of hosts) {
    await client.put(host, siteId)
  }
}

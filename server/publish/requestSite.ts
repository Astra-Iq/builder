/**
 * Request → site resolution for the public (visitor-facing) serving path.
 *
 * Published output is baked per site under `published/<siteId>/…`
 * (`staticArtefact.ts`), so every read of a baked artefact must first know which
 * tenant an inbound request belongs to. This maps the request Host to a
 * `site_id` two ways:
 *
 *   1. Custom domain — the site's `custom_domain` column matches the Host.
 *   2. Subdomain      — the Host is `<slug>.<PUBLIC_BASE_DOMAIN>`; the leading
 *                       label is the site slug.
 *
 * Anything unmatched (including single-tenant installs and the admin/platform
 * host) falls back to the default site, preserving prior behaviour.
 *
 * The resolver runs before the Layer-A disk read on every public request, so a
 * short-TTL memo keeps it from adding a DB hit to that hot path — a domain/slug
 * change propagates within `CACHE_TTL_MS`.
 */
import type { DbClient } from '../db/client'
import { DEFAULT_SITE_ID, getSiteByCustomDomain, getSiteBySlug } from '../repositories/sites'

/**
 * The apex domain merchant subdomains hang off (`<slug>.<PUBLIC_BASE_DOMAIN>`).
 * Set once at boot from `PUBLIC_BASE_DOMAIN`; `null` disables subdomain matching
 * (custom-domain + fallback still work).
 */
let publicBaseDomain: string | null = null

/** Wire the public base domain at boot (see `server/index.ts`). */
export function configurePublicBaseDomain(domain: string | null): void {
  publicBaseDomain = domain ? domain.trim().toLowerCase() || null : null
  hostSiteCache.clear()
}

/**
 * The configured public base domain, or `null`. Used by the edge host-map sync
 * (`edgeHostMap.ts`) to derive a site's `<slug>.<PUBLIC_BASE_DOMAIN>` hostname.
 */
export function getPublicBaseDomain(): string | null {
  return publicBaseDomain
}

// Host → siteId memo. Unknown hosts (bots, the platform apex) cache the default
// too, so a flood of junk Hosts never hammers the DB.
const CACHE_TTL_MS = 60_000
const hostSiteCache = new Map<string, { siteId: string; expiresAt: number }>()

/** Test-only: clear the memo between cases. */
export function __resetRequestSiteCache(): void {
  hostSiteCache.clear()
}

/**
 * Normalise a raw `Host` header to a bare lowercase hostname (no port, IPv6
 * brackets stripped). Returns `null` for an absent or unparseable value.
 */
function normalizeHost(host: string | null): string | null {
  if (!host) return null
  try {
    // The URL parser strips the port and unwraps `[::1]` — no manual regex.
    return new URL(`http://${host}`).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

export async function resolveSiteForRequest(
  db: DbClient,
  host: string | null,
): Promise<string> {
  const hostname = normalizeHost(host)
  if (!hostname) return DEFAULT_SITE_ID

  const cached = hostSiteCache.get(hostname)
  if (cached && cached.expiresAt > Date.now()) return cached.siteId

  const siteId = await resolveUncached(db, hostname)
  hostSiteCache.set(hostname, { siteId, expiresAt: Date.now() + CACHE_TTL_MS })
  return siteId
}

async function resolveUncached(db: DbClient, hostname: string): Promise<string> {
  // 1. Custom domain wins — an explicit per-site mapping.
  const byDomain = await getSiteByCustomDomain(db, hostname)
  if (byDomain) return byDomain.id

  // 2. Subdomain of the platform base domain: `<slug>.<PUBLIC_BASE_DOMAIN>`.
  if (publicBaseDomain && hostname.endsWith(`.${publicBaseDomain}`)) {
    const label = hostname.slice(0, hostname.length - publicBaseDomain.length - 1)
    // Only a single leading label is a slug (`shop.base`, not `a.b.base`).
    if (label && !label.includes('.')) {
      const bySlug = await getSiteBySlug(db, label)
      if (bySlug) return bySlug.id
    }
  }

  // 3. Fallback — single-tenant installs, the platform apex, and any unmatched
  //    host all serve the default site.
  return DEFAULT_SITE_ID
}

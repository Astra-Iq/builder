/**
 * Request → site resolution seam for the public (visitor-facing) serving path.
 *
 * Published output is baked per site under `published/<siteId>/…`
 * (`staticArtefact.ts`), so every read of a baked artefact must first know
 * which tenant an inbound request belongs to. In a full multi-tenant
 * deployment that mapping comes from the request Host / custom domain; until
 * that registry exists, every public request resolves to the single default
 * site. This one function is the seam a real Host→site lookup slots into
 * without touching any serving handler.
 */
import type { DbClient } from '../db/client'
import { DEFAULT_SITE_ID } from '../repositories/sites'

export async function resolveSiteForRequest(
  _db: DbClient,
  _host: string | null,
): Promise<string> {
  // TODO(multi-tenant serving): map `_host` (Host header / custom domain) to a
  // `site_id` via a domain registry, then fall back to the default site. Reads
  // currently serve the single default site — see docs/features/publisher.md
  // "Per-site published output".
  return DEFAULT_SITE_ID
}

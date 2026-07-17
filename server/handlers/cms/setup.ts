/**
 * Public site identity.
 *
 *   GET /admin/api/cms/public-site — site name + favicon URL exposed without
 *                                    auth so the sign-in interstitial and the
 *                                    admin brand row can render the configured
 *                                    mark instead of the default.
 *
 * First-run bootstrap (the default site + starter homepage) now happens at
 * server boot in `ensureBootstrapSite` — there is no in-app setup wizard, since
 * Logto owns identity. This endpoint only exposes the two fields already
 * rendered on every published page (name, favicon), so it adds no info leak.
 */
import type { DbClient } from '../../db/client'
import { jsonResponse, methodNotAllowed } from '../../http'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import type { SiteRow } from '../../types'
import { CMS_API_PREFIX } from './shared'

export async function handleSetupRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === `${CMS_API_PREFIX}/public-site`) {
    if (req.method !== 'GET') return methodNotAllowed()
    return jsonResponse(await loadPublicSiteIdentity(db))
  }

  return null
}

interface PublicSiteIdentity {
  name: string | null
  faviconUrl: string | null
}

/**
 * Persisted `site.settings_json` envelope, narrowed to the ONE field the
 * public identity endpoint reads. The shell's settings are stored under
 * `{ site: { settings: SiteSettings } }` (see `shellToStorage` in
 * `server/repositories/site.ts`), but modelling the full `SiteSettings` shape
 * here would be wrong: its `shortcuts` field is required (backfilled by
 * `parseSiteSettings`, not guaranteed in raw storage) and its `framework` /
 * `fonts` sub-schemas drift independently — any of which would make a valid
 * favicon resolve to null. TypeBox objects allow extra properties by default,
 * so validating only `faviconUrl` still type-checks it with zero `as` casts
 * while staying immune to unrelated settings fields. Every level is optional
 * so a freshly-created site (`settings_json = {}`) yields a null favicon
 * instead of throwing.
 */
const StoredSiteIdentitySchema = Type.Object({
  site: Type.Optional(
    Type.Object({
      settings: Type.Optional(
        Type.Object({
          faviconUrl: Type.Optional(Type.String()),
        }),
      ),
    }),
  ),
})

/**
 * Read the site identity (name + favicon URL) the unauthenticated login /
 * setup screen renders as its brand. Never throws: a missing site row or
 * malformed settings JSON resolves to `{ name: null, faviconUrl: null }`,
 * which the client falls back to the default mark.
 *
 * Only the two fields published pages already expose are returned — no
 * page tree, no plugin list, no user info — so this stays safe to serve
 * without auth.
 */
async function loadPublicSiteIdentity(db: DbClient): Promise<PublicSiteIdentity> {
  const { rows } = await db<SiteRow>`
    select id, name, settings_json, created_at, updated_at
    from sites
    where id = 'default'
    limit 1
  `
  const row = rows[0]
  if (!row) return { name: null, faviconUrl: null }

  // Validate at the boundary, then trust the parsed value. A malformed
  // settings payload fails parsing and resolves to a null favicon — never a
  // thrown error or a silently-wrong value.
  const parsed = safeParseValue(StoredSiteIdentitySchema, row.settings_json)
  const faviconUrl = parsed.ok ? parsed.value.site?.settings?.faviconUrl ?? null : null

  return {
    name: typeof row.name === 'string' && row.name.length > 0 ? row.name : null,
    faviconUrl,
  }
}

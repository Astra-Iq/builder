/**
 * Publish push — ship a freshly-baked site generation to object storage.
 *
 * A full publish bakes every artefact into the site's local-disk slot and swaps
 * it live (`staticArtefact.ts`). For a per-merchant CDN deployment those bytes
 * also need to reach an object store; this module reads the just-swapped active
 * slot and pushes each file to the elected `PublishStorageAdapter` under a
 * per-site key (`sites/<siteId>/<relPath>`).
 *
 * It is derived, best-effort state: the caller invokes it AFTER the local swap,
 * so the site is already live locally. A push failure is logged, never fatal —
 * the local slot remains authoritative and the next publish re-ships the whole
 * generation.
 *
 * The built-in local-disk adapter (`id === ''`) is a no-op, so the default
 * single-host install skips the push entirely with one registry lookup.
 */

import { readActiveSlotArtefacts } from './staticArtefact'
import { LOCAL_PUBLISH_ADAPTER_ID, publishStorageRegistry } from './publishStorageRegistry'

/** Response content-type for a baked artefact, derived from its extension. */
function contentTypeForRelPath(relPath: string): string {
  if (relPath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (relPath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (relPath.endsWith('.js') || relPath.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (relPath.endsWith('.map') || relPath.endsWith('.json')) return 'application/json; charset=utf-8'
  if (relPath.endsWith('.svg')) return 'image/svg+xml'
  if (relPath.endsWith('.png')) return 'image/png'
  if (relPath.endsWith('.jpg') || relPath.endsWith('.jpeg')) return 'image/jpeg'
  if (relPath.endsWith('.gif')) return 'image/gif'
  if (relPath.endsWith('.webp')) return 'image/webp'
  if (relPath.endsWith('.woff2')) return 'font/woff2'
  if (relPath.endsWith('.woff')) return 'font/woff'
  if (relPath.endsWith('.ttf')) return 'font/ttf'
  if (relPath.endsWith('.otf')) return 'font/otf'
  return 'application/octet-stream'
}

/**
 * Push every artefact in the site's active publish slot to the elected storage
 * adapter, keyed `sites/<siteId>/<relPath>`. No-ops when the local-disk adapter
 * is active. Best-effort — errors bubble to the caller's try/catch.
 *
 * TODO(deploy): after a successful push, fire a CDN cache purge for the
 * merchant's domain (deferred — see docs/features/publisher.md).
 */
export async function pushPublishedSite(uploadsDir: string, siteId: string): Promise<void> {
  const adapter = publishStorageRegistry.resolveActive()
  if (adapter.id === LOCAL_PUBLISH_ADAPTER_ID) return

  const files = await readActiveSlotArtefacts(uploadsDir, siteId)
  for (const file of files) {
    await adapter.putObject({
      key: `sites/${siteId}/${file.relPath}`,
      bytes: file.bytes,
      contentType: contentTypeForRelPath(file.relPath),
    })
  }
}

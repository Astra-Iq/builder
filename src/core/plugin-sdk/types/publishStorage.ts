// ---------------------------------------------------------------------------
// Publish storage adapter — object-storage sink for baked static output.
//
// A full publish bakes every page's HTML/CSS/JS into the per-site slot on local
// disk (`server/publish/staticArtefact.ts`). A publish storage adapter is the
// seam that additionally ships that baked generation to a CDN-backed object
// store (S3, Cloudflare R2, GCS, …), keyed per merchant. This is the sibling of
// the media storage adapter (`media.ts`) — same "local disk is the built-in
// default, plugins register remotes" pattern — but publish-shaped: it puts and
// deletes whole objects by key instead of running the media two-round signed
// upload plan.
//
// Note on QuickJS: `putObject` takes the raw bytes host-side. First-party/host
// adapters implement this directly. A future third-party QuickJS adapter that
// must keep bytes out of the 64 MB sandbox heap would register through a
// plan-based bridge (mirroring the media adapter's beginWrite/host-streams
// protocol); that bridge is not wired yet.
// ---------------------------------------------------------------------------

/** One baked artefact to ship to object storage. */
export interface PublishStorageObject {
  /**
   * Object key relative to the storage root — the host always namespaces it
   * per site, e.g. `sites/<siteId>/about.html` or
   * `sites/<siteId>/_instatic/css/style-abc123.css`.
   */
  key: string
  /** Raw artefact bytes (HTML, CSS, runtime JS, …). */
  bytes: Uint8Array
  /** Content-type the CDN should serve, e.g. `text/html; charset=utf-8`. */
  contentType: string
}

/**
 * A storage backend the publish pipeline pushes baked output to.
 *
 * The built-in local-disk adapter uses the reserved id `''` (baked artefacts
 * already live on local disk, so its push is a no-op). A plugin adapter id MUST
 * be `<pluginId>.<rest>`.
 */
export interface PublishStorageAdapter {
  /** Adapter id. `''` is reserved for the built-in local-disk adapter. */
  id: string
  /** Display name in the admin picker, e.g. "Amazon S3", "Cloudflare R2". */
  label: string
  /**
   * Upload one baked artefact. Idempotent — overwrites any object already at
   * `object.key` (a republish ships the whole generation again).
   */
  putObject: (object: PublishStorageObject) => Promise<void>
  /** Hard-delete one object by key. Idempotent — MUST swallow "already gone". */
  deleteObject: (key: string) => Promise<void>
  /**
   * Optional: delete every object under a key prefix. Used to prune a retired
   * generation (`sites/<siteId>/…`). Idempotent.
   */
  deletePrefix?: (prefix: string) => Promise<void>
}

/**
 * Instatic edge serving Worker.
 *
 * Serves per-merchant published sites from an R2 bucket the app pushes to.
 * For each request:
 *   1. resolve the Host → siteId via the KV namespace the app keeps in sync
 *      (`server/publish/edgeHostMap.ts`),
 *   2. map the URL path to the object key the app baked
 *      (mirrors `urlToDiskRelPath` in `server/publish/staticArtefact.ts`),
 *   3. fetch `sites/<siteId>/<key>` from R2, falling back to `404.html`.
 *
 * Bindings (see wrangler.toml):
 *   SITE_MAP — KV namespace of `host → siteId`
 *   BUCKET   — R2 bucket the app publishes into
 *
 * Deployed with wrangler; not part of the app's build. Requires
 * `@cloudflare/workers-types` for local type-checking.
 */

interface Env {
  SITE_MAP: KVNamespace
  BUCKET: R2Bucket
}

/**
 * URL path → object key suffix. Mirrors the app's bake rules:
 *   `/`        → index.html
 *   `/foo/`    → foo/index.html
 *   `/foo/bar` → foo/bar.html         (page: no extension)
 *   `/a/b.css` → a/b.css              (asset: has extension → verbatim)
 */
function pathToKey(pathname: string): string {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, '')
  if (decoded === '' || decoded.endsWith('/')) return `${decoded}index.html`
  const last = decoded.slice(decoded.lastIndexOf('/') + 1)
  return last.includes('.') ? decoded : `${decoded}.html`
}

function cacheControl(pathname: string): string {
  // Content-hashed assets under /_instatic/ are immutable; HTML revalidates.
  return pathname.startsWith('/_instatic/')
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=60, must-revalidate'
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const siteId = await env.SITE_MAP.get(url.hostname.toLowerCase())
    if (!siteId) return new Response('Unknown site', { status: 404 })

    const prefix = `sites/${siteId}`
    let status = 200
    let object = await env.BUCKET.get(`${prefix}/${pathToKey(url.pathname)}`)
    if (!object) {
      status = 404
      object = await env.BUCKET.get(`${prefix}/404.html`)
      if (!object) return new Response('Not found', { status: 404 })
    }

    const headers = new Headers()
    object.writeHttpMetadata(headers) // restores the Content-Type set at push time
    headers.set('etag', object.httpEtag)
    headers.set('cache-control', cacheControl(url.pathname))
    return new Response(request.method === 'HEAD' ? null : object.body, { status, headers })
  },
}

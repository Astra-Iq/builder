# Cloudflare edge serving

Serves per-merchant published sites from R2 at the edge. The app pushes baked
output to R2 (`sites/<siteId>/…`, via `PUBLISH_STORAGE_*`) and syncs a
`host → siteId` map into Cloudflare KV on every publish (via `PUBLISH_KV_*`). This
Worker ties them together: resolve the request Host to a `siteId` through KV, then
serve the object out of R2.

## How it maps requests

- **Host → siteId**: `SITE_MAP.get(hostname)`. Populated by the app for each
  site's `<slug>.<PUBLIC_BASE_DOMAIN>` subdomain and its `custom_domain`.
- **Path → object key**: mirrors the app's bake rules (`server/publish/staticArtefact.ts`):
  `/` → `index.html`, `/foo/` → `foo/index.html`, `/foo/bar` → `foo/bar.html`,
  and any path with a file extension (e.g. `/_instatic/css/x.css`) is served
  verbatim. Misses fall back to the site's `404.html` with a 404 status.
- **Content-Type** comes from the object's stored metadata (set at push time);
  `/_instatic/*` assets are content-hashed and served `immutable`, HTML short.

## One-time setup

1. **Create the KV namespace** and copy its id into `wrangler.toml` and the app's
   `PUBLISH_KV_NAMESPACE_ID`:
   ```sh
   wrangler kv namespace create SITE_MAP
   ```
2. **Point the R2 binding** at the same bucket as the app's `PUBLISH_STORAGE_BUCKET`.
3. **Configure the app** so publishes populate both:
   ```sh
   PUBLISH_STORAGE_ENDPOINT=…  PUBLISH_STORAGE_BUCKET=published-sites
   PUBLISH_STORAGE_ACCESS_KEY_ID=…  PUBLISH_STORAGE_SECRET_ACCESS_KEY=…
   PUBLISH_KV_ACCOUNT_ID=…  PUBLISH_KV_NAMESPACE_ID=…  PUBLISH_KV_API_TOKEN=…
   PUBLIC_BASE_DOMAIN=shopzoon.app
   ```
   The KV API token needs **Workers KV Storage: Edit** on the account.
4. **DNS / TLS**:
   - Add a proxied wildcard record `*.shopzoon.app` so Cloudflare terminates TLS
     and the Worker route catches every merchant subdomain. Cloudflare issues the
     `*.<zone>` edge certificate automatically.
   - For merchant **custom domains**, use **Cloudflare for SaaS** (SSL for SaaS)
     to provision a per-hostname certificate, and make sure the app has written
     `custom_domain → siteId` into KV for that host.
5. **Deploy**:
   ```sh
   wrangler deploy
   ```

## Local development

```sh
wrangler dev
```
Seed a KV entry and load a host to test the mapping:
```sh
wrangler kv key put --binding SITE_MAP "alpha.localhost" "<siteId>"
curl -H "Host: alpha.localhost" http://localhost:8787/
```

## Notes

- Objects are pushed **private**; the Worker (with the R2 binding) is what makes
  them reachable — you do not need a public bucket.
- Cache invalidation on publish is not automatic yet: HTML carries a short TTL
  (`max-age=60`), and content-hashed assets never need purging. A publish-time CDN
  purge is a planned follow-up.

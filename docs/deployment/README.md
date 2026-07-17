# Deployment

This index maps supported deployment targets to the files, variables, and persistence rules they need.

Instatic is one Bun server packaged by the root `Dockerfile`. The server reads runtime configuration from `server/config.ts`: `PORT`, `DATABASE_URL`, `UPLOADS_DIR`, `STATIC_DIR`, `PUBLIC_ORIGIN`, `TRUSTED_PROXY_CIDRS`, `PUBLIC_BASE_DOMAIN`, `PUBLISH_STORAGE_*`, and `PUBLISH_KV_*`. Reversible server secrets, including AI provider credentials, plugin secret settings, and MFA TOTP seeds, are encrypted with `INSTATIC_SECRET_KEY` when configured. Database migrations run automatically on boot in `server/index.ts`.

---

## TL;DR

| Target | Use when | Database | Persistent storage | Docs |
|---|---|---|---|---|
| Railway SQLite template | Fastest managed install for a single site | SQLite file | One Railway app volume mounted at `/app/storage` | [railway.md](railway.md) |
| Railway Postgres template | Managed install for teams or horizontal scale later | Railway Postgres | App volume for uploads, Postgres service volume for DB | [railway.md](railway.md) |
| Render SQLite template | Managed Docker install outside Railway | SQLite file | One Render disk mounted at `/app/storage` | [render.md](render.md) |
| Render Postgres template | Managed Postgres install outside Railway | Render Postgres | Render disk for uploads, Render Postgres storage for DB | [render.md](render.md) |
| VPS Docker Compose | Self-hosted server, full control | SQLite or bundled Postgres | Docker named volumes | [vps.md](vps.md) |
| Generic Docker host | Any platform that runs the Dockerfile/image | SQLite or external Postgres | A mounted directory/volume for DB/uploads | [docker-image.md](docker-image.md) |
| VPS HTTPS | Public domain on a VPS | Unchanged | Caddy cert volume plus app volumes | [tls-caddy.md](tls-caddy.md) |

Back up both the database and uploaded media. See [backup-restore.md](backup-restore.md).

## Runtime Contract

Every deployment target configures the same process:

```txt
PORT          HTTP port the Bun server listens on
DATABASE_URL  sqlite:/path/to/cms.db, file:/path/to/cms.db, postgres://..., or postgresql://...
UPLOADS_DIR   directory for media, plugin packs, fonts, and published disk artefacts
STATIC_DIR    built admin SPA directory; /app/dist in the Docker image
INSTATIC_SECRET_KEY  base64 32-byte key for encrypted server secrets
PUBLIC_ORIGIN        comma-separated public origin(s) the CSRF check trusts; auto-detected from RENDER_EXTERNAL_URL / RAILWAY_PUBLIC_DOMAIN on those platforms
TRUSTED_PROXY_CIDRS  optional; trusts proxy socket peers for forwarded client-IP attribution only (audit logs, rate-limit keys) — NOT used for CSRF
PUBLIC_BASE_DOMAIN   optional; apex domain merchant sites hang off as <slug>.<PUBLIC_BASE_DOMAIN> for per-site serving (custom domains resolve via each site's custom_domain regardless)
PUBLISH_STORAGE_*    optional; when ENDPOINT + BUCKET + ACCESS_KEY_ID + SECRET_ACCESS_KEY are set, each publish is pushed to that S3/R2 bucket under sites/<siteId>/… (REGION defaults to "auto")
PUBLISH_KV_*         optional; ACCOUNT_ID + NAMESPACE_ID + API_TOKEN sync host → siteId into Cloudflare KV on each publish so the edge Worker (deploy/cloudflare/) can serve per-merchant
```

Generate `INSTATIC_SECRET_KEY` with `bun run scripts/generate-secret-key.ts` before adding Anthropic, OpenAI, or OpenRouter credentials or enabling TOTP MFA in production. Without it, the admin can load but saving reversible secrets fails because there is no stable encryption key.

The Docker image sets:

```txt
PORT=3001
STATIC_DIR=/app/dist
UPLOADS_DIR=/app/uploads
```

Managed platforms often override `PORT`. That is fine; the server uses `process.env.PORT`. When a managed platform terminates HTTPS before forwarding HTTP to the container, the CSRF origin check derives the site's public origin from `PUBLIC_ORIGIN` — auto-detected from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN` on Render and Railway, so one-click deploys need no manual value. Set `PUBLIC_ORIGIN` explicitly (a comma-separated list) when adding a custom domain. `TRUSTED_PROXY_CIDRS` is independent of CSRF and only attributes the real client IP for audit logs and rate-limit keys.

## Image Availability

Release bundles plus the published GHCR image are the default portable install path:

```sh
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:latest docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

Pin a semver tag for predictable upgrades:

```sh
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:0.0.11 docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

Source builds remain supported for contributors and release-candidate testing:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.build.yml up -d --build
```

The maintainer release target is `ghcr.io/corebunch/instatic`, documented in [release-workflow.md](release-workflow.md).

## Database Choice

The database engine is selected only by `DATABASE_URL`:

| URL shape | Engine |
|---|---|
| `sqlite:/path/to/cms.db` | SQLite |
| `file:/path/to/cms.db` | SQLite |
| `/path/to/cms.db` | SQLite |
| `postgres://...` | Postgres |
| `postgresql://...` | Postgres |

SQLite is the default for single-site installs. Postgres is for multiple simultaneous admin writers, more than one app container, or operators who already want managed Postgres.

## Persistence Rules

`UPLOADS_DIR` is required for durable media regardless of the database engine. It stores:

- uploaded media originals and variants
- uploaded fonts
- plugin packages and module packs
- published static artefacts under `published/<siteId>/current` (one isolated two-slot tree per site)

SQLite installs also need the SQLite database file on persistent storage. On platforms with only one app volume, put both the SQLite file and uploads under the same mounted root.

## Publishing to object storage (optional)

By default published pages are served off local disk (`UPLOADS_DIR`). To also push each publish to an object store — for CDN/edge serving or per-merchant offload — set `PUBLISH_STORAGE_ENDPOINT`, `PUBLISH_STORAGE_BUCKET`, `PUBLISH_STORAGE_ACCESS_KEY_ID`, and `PUBLISH_STORAGE_SECRET_ACCESS_KEY` (all four required; unset = local disk only). Every publish then uploads its baked files to `sites/<siteId>/…` in the bucket.

Any S3-compatible store works — AWS S3, Cloudflare R2, MinIO, RustFS — because the adapter uses Bun's native S3 client (no SDK). Notes:

- **Endpoint** is the base server URL, path-style (no bucket in it): `http://minio:9000` for MinIO/RustFS, `https://<account>.r2.cloudflarestorage.com` for R2.
- **`PUBLISH_STORAGE_REGION`** defaults to `auto`; set `us-east-1` for MinIO/RustFS.
- **Objects upload private.** To serve them, make the bucket/prefix public-readable (e.g. `mc anonymous set download <alias>/<bucket>`) or front it with a credentialed CDN. The app itself does not read pages back out of the bucket — it still serves from local disk; the push is the edge-offload side.
- Multi-tenant serving from the app is controlled separately by `PUBLIC_BASE_DOMAIN` (merchant subdomains) plus each site's `custom_domain`.

To actually **serve those bucket objects at the edge** per merchant, deploy the Cloudflare Worker in [../../deploy/cloudflare/](../../deploy/cloudflare/): set `PUBLISH_KV_*` so each publish syncs `host → siteId` into a Cloudflare KV namespace, and the Worker resolves the request Host through KV and serves the object out of R2. See that directory's README for DNS, Cloudflare-for-SaaS custom-domain certs, and `wrangler` deploy steps.

Mechanics: [../features/publisher.md](../features/publisher.md) → "Enabling S3 / R2" and "Serving from the edge".

## Docs Inventory

| File | Role |
|---|---|
| [railway.md](railway.md) | Railway templates for SQLite and Postgres |
| [render.md](render.md) | Render Blueprint templates for SQLite and Postgres |
| [vps.md](vps.md) | Docker Compose on a VPS, both SQLite and Postgres |
| [docker-image.md](docker-image.md) | Generic Docker image contract and `docker run` examples |
| [tls-caddy.md](tls-caddy.md) | Caddy TLS overlay for VPS Compose installs |
| [backup-restore.md](backup-restore.md) | Database and uploads backup/restore |
| [release-workflow.md](release-workflow.md) | Maintainer image publishing workflow |

## Related

- `server/config.ts` — runtime env parsing
- `server/db/index.ts` — database URL detection
- `server/index.ts` — migrations, media storage, and server boot
- `Dockerfile` — production image contract
- `compose.prod.yml`, `compose.sqlite.yml`, `compose.tls.yml`, `compose.build.yml` — VPS Compose files
- `docs/deployment/render/sqlite/render.yaml`, `docs/deployment/render/postgres/render.yaml` — Render Blueprint templates

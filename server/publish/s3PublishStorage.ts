/**
 * First-party S3 / R2 publish storage adapter.
 *
 * Ships baked artefacts to any S3-compatible object store (AWS S3, Cloudflare R2,
 * MinIO, …) via Bun's native `Bun.S3Client` — no provider SDK, satisfying the
 * repo-wide SDK ban. R2 works by pointing `endpoint` at
 * `https://<account>.r2.cloudflarestorage.com`.
 *
 * Election is by env presence: `server/index.ts` registers this adapter at boot
 * when `PUBLISH_STORAGE_*` is configured, and `publishStorageRegistry.resolveActive`
 * then returns it for every publish push (`publishPush.ts`).
 */

import type { PublishStorageAdapter } from '@core/plugin-sdk'

/** Connection config for the S3/R2 bucket. */
export interface S3PublishConfig {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * The slice of `Bun.S3Client` the adapter uses. Injectable so tests pass a fake
 * without a live bucket.
 */
export interface S3PublishClient {
  write(path: string, data: Uint8Array, options?: { type?: string }): Promise<number> | number
  delete(path: string): Promise<void>
}

function defaultClient(config: S3PublishConfig): S3PublishClient {
  const bucket = new Bun.S3Client({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  })
  // Wrap so the adapter depends only on the two methods it needs.
  return {
    write: (path, data, options) => bucket.write(path, data, options),
    delete: (path) => bucket.delete(path),
  }
}

export function createS3PublishAdapter(
  config: S3PublishConfig,
  client: S3PublishClient = defaultClient(config),
): PublishStorageAdapter {
  return {
    id: 's3',
    label: 'S3 / R2',
    putObject: async ({ key, bytes, contentType }) => {
      await client.write(key, bytes, { type: contentType })
    },
    deleteObject: async (key) => {
      await client.delete(key)
    },
  }
}

/**
 * The first-party S3/R2 publish adapter maps the PublishStorageAdapter contract
 * onto a Bun.S3Client-shaped client. Tests inject a spy client — no live bucket.
 */
import { describe, expect, it } from 'bun:test'
import { createS3PublishAdapter, type S3PublishClient } from '../s3PublishStorage'

const CONFIG = {
  endpoint: 'https://acc.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'sites',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
}

function makeSpyClient(): {
  client: S3PublishClient
  writes: Array<{ path: string; data: Uint8Array; type?: string }>
  deletes: string[]
} {
  const writes: Array<{ path: string; data: Uint8Array; type?: string }> = []
  const deletes: string[] = []
  const client: S3PublishClient = {
    write: async (path, data, options) => {
      writes.push({ path, data, type: options?.type })
      return data.byteLength
    },
    delete: async (path) => {
      deletes.push(path)
    },
  }
  return { client, writes, deletes }
}

describe('createS3PublishAdapter', () => {
  it('putObject writes the bytes at the key with its content-type', async () => {
    const { client, writes } = makeSpyClient()
    const adapter = createS3PublishAdapter(CONFIG, client)
    expect(adapter.id).toBe('s3')

    const bytes = new TextEncoder().encode('<html>hi</html>')
    await adapter.putObject({
      key: 'sites/shop-1/index.html',
      bytes,
      contentType: 'text/html; charset=utf-8',
    })

    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe('sites/shop-1/index.html')
    expect(writes[0].type).toBe('text/html; charset=utf-8')
    expect(new TextDecoder().decode(writes[0].data)).toBe('<html>hi</html>')
  })

  it('deleteObject deletes the key', async () => {
    const { client, deletes } = makeSpyClient()
    const adapter = createS3PublishAdapter(CONFIG, client)
    await adapter.deleteObject('sites/shop-1/old.html')
    expect(deletes).toEqual(['sites/shop-1/old.html'])
  })
})

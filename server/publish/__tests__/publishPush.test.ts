/**
 * Per-site publish isolation + object-storage push.
 *
 * Proves two things end-to-end against a real tmpdir slot tree:
 *   1. Baked output is isolated per site — a read scoped to one site never
 *      sees another site's artefacts (the `published/<siteId>/…` layout).
 *   2. The publish push ships the baked generation to the elected
 *      `PublishStorageAdapter`, keyed `sites/<siteId>/…`; the built-in
 *      local-disk adapter is a no-op.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PublishStorageAdapter, PublishStorageObject } from '@core/plugin-sdk'
import {
  prepareInactiveSlot,
  readArtefact,
  swapSlot,
  writeArtefact,
  writeStaticAsset,
} from '../staticArtefact'
import { publishStorageRegistry } from '../publishStorageRegistry'
import { pushPublishedSite } from '../publishPush'

let uploadsDir: string

beforeEach(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), 'publish-push-'))
  publishStorageRegistry.__reset()
  publishStorageRegistry.configureLocalDisk()
})

afterEach(async () => {
  await rm(uploadsDir, { recursive: true, force: true })
  publishStorageRegistry.__reset()
})

/** Bake a full generation into one site's inactive slot and swap it live. */
async function bakeSite(
  siteId: string,
  pages: Record<string, string>,
  assets: Record<string, string> = {},
): Promise<void> {
  const { slot, slotDir } = await prepareInactiveSlot(uploadsDir, siteId)
  for (const [urlPath, html] of Object.entries(pages)) {
    await writeArtefact(slotDir, urlPath, html)
  }
  for (const [publicPath, content] of Object.entries(assets)) {
    await writeStaticAsset(slotDir, publicPath, new TextEncoder().encode(content))
  }
  await swapSlot(uploadsDir, siteId, slot)
}

function makeSpyAdapter(id = 'acme.s3'): {
  adapter: PublishStorageAdapter
  puts: PublishStorageObject[]
  deletes: string[]
} {
  const puts: PublishStorageObject[] = []
  const deletes: string[] = []
  const adapter: PublishStorageAdapter = {
    id,
    label: 'Spy',
    putObject: async (object) => {
      puts.push(object)
    },
    deleteObject: async (key) => {
      deletes.push(key)
    },
  }
  return { adapter, puts, deletes }
}

describe('per-site slot isolation', () => {
  it('a read scoped to one site never sees another site’s artefacts', async () => {
    await bakeSite('site-a', { '/': '<html>A home</html>', '/about': '<html>A about</html>' })
    await bakeSite('site-b', { '/': '<html>B home</html>' })

    expect(await readArtefact(uploadsDir, 'site-a', '/')).toBe('<html>A home</html>')
    expect(await readArtefact(uploadsDir, 'site-b', '/')).toBe('<html>B home</html>')
    // `/about` exists only in site A — site B must not resolve it.
    expect(await readArtefact(uploadsDir, 'site-a', '/about')).toBe('<html>A about</html>')
    expect(await readArtefact(uploadsDir, 'site-b', '/about')).toBeNull()
  })
})

describe('publishStorageRegistry', () => {
  it('resolveActive returns local disk by default and a remote once registered', () => {
    expect(publishStorageRegistry.resolveActive().id).toBe('')
    const { adapter } = makeSpyAdapter()
    publishStorageRegistry.register(adapter)
    expect(publishStorageRegistry.resolveActive().id).toBe('acme.s3')
  })

  it('rejects the reserved empty id', () => {
    expect(() =>
      publishStorageRegistry.register({
        id: '',
        label: 'x',
        putObject: async () => {},
        deleteObject: async () => {},
      }),
    ).toThrow()
  })

  it('unregisterPlugin tears down every adapter under a plugin id', () => {
    publishStorageRegistry.register(makeSpyAdapter('acme.s3').adapter)
    publishStorageRegistry.unregisterPlugin('acme')
    expect(publishStorageRegistry.resolveActive().id).toBe('')
  })
})

describe('pushPublishedSite', () => {
  it('is a no-op when the local-disk adapter is active', async () => {
    await bakeSite('default', { '/': '<html>home</html>' })
    const { adapter, puts } = makeSpyAdapter()
    // Registered but the test asserts the DEFAULT (local) path: unregister so
    // resolveActive falls back to local disk.
    publishStorageRegistry.register(adapter)
    publishStorageRegistry.unregisterPlugin('acme')
    await pushPublishedSite(uploadsDir, 'default')
    expect(puts).toHaveLength(0)
  })

  it('ships every baked artefact to the elected remote adapter, keyed per site', async () => {
    await bakeSite(
      'shop-1',
      { '/': '<html>home</html>', '/about': '<html>about</html>' },
      { '/_instatic/css/style-abc123.css': 'body{color:red}' },
    )
    const { adapter, puts } = makeSpyAdapter()
    publishStorageRegistry.register(adapter)

    await pushPublishedSite(uploadsDir, 'shop-1')

    const keys = puts.map((p) => p.key).sort()
    expect(keys).toEqual([
      'sites/shop-1/_instatic/css/style-abc123.css',
      'sites/shop-1/about.html',
      'sites/shop-1/index.html',
    ])
    const home = puts.find((p) => p.key === 'sites/shop-1/index.html')!
    expect(home.contentType).toBe('text/html; charset=utf-8')
    expect(new TextDecoder().decode(home.bytes)).toBe('<html>home</html>')
    const css = puts.find((p) => p.key.endsWith('.css'))!
    expect(css.contentType).toBe('text/css; charset=utf-8')
  })

  it('keys are namespaced so two sites never collide in the bucket', async () => {
    await bakeSite('shop-1', { '/': '<html>one</html>' })
    await bakeSite('shop-2', { '/': '<html>two</html>' })
    const { adapter, puts } = makeSpyAdapter()
    publishStorageRegistry.register(adapter)

    await pushPublishedSite(uploadsDir, 'shop-1')
    await pushPublishedSite(uploadsDir, 'shop-2')

    expect(puts.map((p) => p.key).sort()).toEqual([
      'sites/shop-1/index.html',
      'sites/shop-2/index.html',
    ])
  })
})

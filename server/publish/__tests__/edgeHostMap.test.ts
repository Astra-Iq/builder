/**
 * syncSiteHostMappings upserts the serving hostnames (subdomain + custom domain)
 * of a site into the edge KV client. Injects a fake client — no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createTestDb, type TestDb } from '../../../src/__tests__/helpers/createTestDb'
import { configurePublicBaseDomain } from '../requestSite'
import { configureEdgeHostMap, syncSiteHostMappings } from '../edgeHostMap'
import type { EdgeHostMapClient } from '../cloudflareKv'

function fakeClient(): { client: EdgeHostMapClient; puts: Array<{ key: string; value: string }> } {
  const puts: Array<{ key: string; value: string }> = []
  return {
    client: {
      put: async (key, value) => {
        puts.push({ key, value })
      },
      delete: async () => {},
    },
    puts,
  }
}

describe('syncSiteHostMappings', () => {
  let testDb: TestDb
  let db: TestDb['db']

  beforeEach(async () => {
    testDb = await createTestDb()
    db = testDb.db
    configurePublicBaseDomain('shopzoon.app')
    await db`insert into sites (id, name, slug, status, custom_domain) values ('site-a', 'A', 'alpha', 'active', 'shop-a.com')`
    await db`insert into sites (id, name, slug, status, custom_domain) values ('site-b', 'B', 'beta', 'active', null)`
  })

  afterEach(async () => {
    configureEdgeHostMap(null)
    configurePublicBaseDomain(null)
    await testDb.cleanup()
  })

  it('upserts both the subdomain and the custom domain', async () => {
    const { client, puts } = fakeClient()
    configureEdgeHostMap(client)
    await syncSiteHostMappings(db, 'site-a')
    expect(puts).toEqual([
      { key: 'alpha.shopzoon.app', value: 'site-a' },
      { key: 'shop-a.com', value: 'site-a' },
    ])
  })

  it('upserts only the subdomain when there is no custom domain', async () => {
    const { client, puts } = fakeClient()
    configureEdgeHostMap(client)
    await syncSiteHostMappings(db, 'site-b')
    expect(puts).toEqual([{ key: 'beta.shopzoon.app', value: 'site-b' }])
  })

  it('skips the subdomain when no base domain is configured', async () => {
    configurePublicBaseDomain(null)
    const { client, puts } = fakeClient()
    configureEdgeHostMap(client)
    await syncSiteHostMappings(db, 'site-a')
    expect(puts).toEqual([{ key: 'shop-a.com', value: 'site-a' }])
  })

  it('is a no-op when the edge client is unconfigured', async () => {
    configureEdgeHostMap(null)
    // Must not throw despite no client.
    await syncSiteHostMappings(db, 'site-a')
  })

  it('is a no-op for an unknown site', async () => {
    const { client, puts } = fakeClient()
    configureEdgeHostMap(client)
    await syncSiteHostMappings(db, 'does-not-exist')
    expect(puts).toEqual([])
  })
})

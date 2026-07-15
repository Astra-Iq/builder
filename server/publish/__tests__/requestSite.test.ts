/**
 * Host → site resolution for the public serving path: custom-domain match,
 * `<slug>.<PUBLIC_BASE_DOMAIN>` subdomain match, fallback to the default site,
 * and the short-TTL memo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createTestDb, type TestDb } from '../../../src/__tests__/helpers/createTestDb'
import {
  __resetRequestSiteCache,
  configurePublicBaseDomain,
  resolveSiteForRequest,
} from '../requestSite'

describe('resolveSiteForRequest', () => {
  let testDb: TestDb
  let db: TestDb['db']

  beforeEach(async () => {
    testDb = await createTestDb()
    db = testDb.db
    __resetRequestSiteCache()
    configurePublicBaseDomain('shopzoon.app')
    await db`insert into sites (id, name, slug, status, custom_domain) values ('site-a', 'A', 'alpha', 'active', 'shop-a.com')`
    await db`insert into sites (id, name, slug, status, custom_domain) values ('site-b', 'B', 'beta', 'active', null)`
    await db`insert into sites (id, name, slug, status, custom_domain) values ('site-c', 'C', 'gamma', 'suspended', null)`
  })

  afterEach(async () => {
    __resetRequestSiteCache()
    configurePublicBaseDomain(null)
    await testDb.cleanup()
  })

  it('maps a custom domain to its site (port stripped)', async () => {
    expect(await resolveSiteForRequest(db, 'shop-a.com')).toBe('site-a')
    expect(await resolveSiteForRequest(db, 'shop-a.com:443')).toBe('site-a')
    expect(await resolveSiteForRequest(db, 'SHOP-A.COM')).toBe('site-a')
  })

  it('maps <slug>.<base> subdomains to their site', async () => {
    expect(await resolveSiteForRequest(db, 'alpha.shopzoon.app')).toBe('site-a')
    expect(await resolveSiteForRequest(db, 'beta.shopzoon.app')).toBe('site-b')
  })

  it('falls back to the default site for the apex, unknown, and missing hosts', async () => {
    expect(await resolveSiteForRequest(db, 'shopzoon.app')).toBe('default')
    expect(await resolveSiteForRequest(db, 'unknown.example.com')).toBe('default')
    expect(await resolveSiteForRequest(db, null)).toBe('default')
  })

  it('does not treat a multi-label subdomain as a slug', async () => {
    expect(await resolveSiteForRequest(db, 'x.beta.shopzoon.app')).toBe('default')
  })

  it('never serves a non-active site', async () => {
    // `gamma` exists but is suspended → no match → default.
    expect(await resolveSiteForRequest(db, 'gamma.shopzoon.app')).toBe('default')
  })

  it('caches by host; the reset picks up a changed mapping', async () => {
    expect(await resolveSiteForRequest(db, 'beta.shopzoon.app')).toBe('site-b')
    // Change the slug out from under the cache — the memo keeps the old answer.
    await db`update sites set slug = 'beta2' where id = 'site-b'`
    expect(await resolveSiteForRequest(db, 'beta.shopzoon.app')).toBe('site-b')
    // After a reset, `beta` no longer matches any active slug → default.
    __resetRequestSiteCache()
    expect(await resolveSiteForRequest(db, 'beta.shopzoon.app')).toBe('default')
  })

  it('with no base domain configured, only custom domains and fallback resolve', async () => {
    configurePublicBaseDomain(null)
    __resetRequestSiteCache()
    expect(await resolveSiteForRequest(db, 'shop-a.com')).toBe('site-a')
    expect(await resolveSiteForRequest(db, 'alpha.shopzoon.app')).toBe('default')
  })
})

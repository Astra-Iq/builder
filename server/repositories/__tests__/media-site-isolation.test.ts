/**
 * Behavioural proof that the media repositories isolate assets + folders per
 * site: a query scoped to site A never sees site B's rows, and a by-id op with
 * the wrong site resolves to null (no cross-tenant reach by guessed id).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createTestDb, type TestDb } from '../../../src/__tests__/helpers/createTestDb'
import { createSite } from '../setup'
import {
  createMediaAsset,
  listMediaAssets,
  getMediaAsset,
  renameMediaAsset,
  softDeleteMediaAsset,
  deleteMediaAsset,
} from '../media'
import { createMediaFolder, listMediaFolders, getMediaFolder } from '../mediaFolders'

const SITE_A = 'site-a'
const SITE_B = 'site-b'

async function seedAsset(db: TestDb['db'], siteId: string, id: string) {
  return createMediaAsset(db, {
    id,
    siteId,
    filename: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 10,
    storagePath: `${id}.png`,
    publicPath: `/uploads/${id}.png`,
    uploadedByUserId: null,
    storageAdapterId: '',
    externallyHosted: false,
  })
}

describe('media repositories — per-site isolation', () => {
  let testDb: TestDb
  let db: TestDb['db']

  beforeEach(async () => {
    testDb = await createTestDb()
    db = testDb.db
    // `createSite` is a `default`-id upsert; insert the two tenants directly.
    await createSite(db, 'Default', {})
    await db`insert into sites (id, name, slug, settings_json) values (${SITE_A}, ${'A'}, ${SITE_A}, ${'{}'})`
    await db`insert into sites (id, name, slug, settings_json) values (${SITE_B}, ${'B'}, ${SITE_B}, ${'{}'})`
    await seedAsset(db, SITE_A, 'a-asset')
    await seedAsset(db, SITE_B, 'b-asset')
  })

  afterEach(async () => {
    await testDb.cleanup()
  })

  it('listMediaAssets returns only the requested site’s assets', async () => {
    const aAssets = await listMediaAssets(db, SITE_A)
    const bAssets = await listMediaAssets(db, SITE_B)
    expect(aAssets.map((a) => a.id)).toEqual(['a-asset'])
    expect(bAssets.map((a) => a.id)).toEqual(['b-asset'])
  })

  it('getMediaAsset with the wrong site resolves to null', async () => {
    expect(await getMediaAsset(db, SITE_A, 'a-asset')).not.toBeNull()
    expect(await getMediaAsset(db, SITE_B, 'a-asset')).toBeNull()
  })

  it('by-id writes cannot reach across tenants', async () => {
    // Renaming site A's asset from site B must miss and leave it untouched.
    expect(await renameMediaAsset(db, SITE_B, 'a-asset', 'hijacked.png')).toBeNull()
    const stillThere = await getMediaAsset(db, SITE_A, 'a-asset')
    expect(stillThere?.filename).toBe('a-asset.png')

    // Soft-delete + hard-delete from the wrong site are no-ops.
    expect(await softDeleteMediaAsset(db, SITE_B, 'a-asset')).toBeNull()
    expect(await deleteMediaAsset(db, SITE_B, 'a-asset')).toBeNull()
    expect(await getMediaAsset(db, SITE_A, 'a-asset')).not.toBeNull()
  })

  it('folders are isolated per site', async () => {
    await createMediaFolder(db, {
      id: 'a-folder',
      siteId: SITE_A,
      parentId: null,
      name: 'Logos',
      slug: 'logos',
      createdByUserId: null,
    })
    await createMediaFolder(db, {
      id: 'b-folder',
      siteId: SITE_B,
      parentId: null,
      name: 'Logos',
      slug: 'logos',
      createdByUserId: null,
    })
    expect((await listMediaFolders(db, SITE_A)).map((f) => f.id)).toEqual(['a-folder'])
    expect((await listMediaFolders(db, SITE_B)).map((f) => f.id)).toEqual(['b-folder'])
    expect(await getMediaFolder(db, SITE_B, 'a-folder')).toBeNull()
  })
})

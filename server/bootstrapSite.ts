/**
 * Site content bootstrap.
 *
 * With Logto owning identity there is no in-app "create the first owner"
 * wizard. What setup still needs is a starter homepage so a freshly-created
 * site opens to something editable rather than an empty canvas.
 *
 *  - `ensureBootstrapSite` runs at server boot: on a fresh install it creates
 *    the adopted `default` site shell + a starter homepage.
 *  - `ensureSiteHasHomePage` runs at login for each org the user may edit: a
 *    per-tenant site provisioned by `ensureSiteForOrg` has a `sites` row but no
 *    content, so this seeds a homepage the first time (idempotent — a no-op
 *    once the site has any page).
 */
import { nanoid } from 'nanoid'
import type { DbClient } from './db/client'
import { createSite } from './repositories/setup'
import { createDataRow } from './repositories/data'
import { createNode } from '@core/page-tree'
import type { Page } from '@core/page-tree'
import { pageToCells } from '../src/core/data/pageFromRow'

/** Create a site's starter Home page (an empty `base.body`) scoped to `siteId`. */
export async function seedStarterHomePage(db: DbClient, siteId: string): Promise<void> {
  const rootNode = createNode('base.body')
  const homePage: Page = {
    id: nanoid(),
    title: 'Home',
    slug: 'index',
    nodes: { [rootNode.id]: rootNode },
    rootNodeId: rootNode.id,
  }
  // Authorship is null — the seed is system-created, not attributed to a user.
  await createDataRow(
    db,
    { id: homePage.id, siteId, tableId: 'pages', cells: pageToCells(homePage), slug: homePage.slug },
    null,
  )
}

/**
 * Seed a starter homepage for `siteId` if it has no pages yet. Idempotent:
 * once the site has any (non-deleted) page this is a no-op. Called at login for
 * each org site so a newly-provisioned tenant — or one created before content
 * seeding existed — always opens to an editable page.
 */
export async function ensureSiteHasHomePage(db: DbClient, siteId: string): Promise<void> {
  const { rows } = await db<{ count: number }>`
    select count(*) as count from data_rows
    where site_id = ${siteId} and table_id = 'pages' and deleted_at is null
  `
  if (Number(rows[0]?.count ?? 0) > 0) return
  await seedStarterHomePage(db, siteId)
}

export async function ensureBootstrapSite(db: DbClient): Promise<void> {
  const { rows } = await db<{ count: number }>`select count(*) as count from sites`
  if (Number(rows[0]?.count ?? 0) > 0) return

  await db.transaction(async (tx) => {
    await createSite(tx, 'My Site', {})
    await seedStarterHomePage(tx, 'default')
  })
}

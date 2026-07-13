/**
 * First-run site bootstrap.
 *
 * With Logto owning identity there is no in-app "create the first owner"
 * wizard anymore. The one thing setup still needs to do — create the default
 * site shell and a starter homepage so the editor has something to open — now
 * happens idempotently at boot. Runs once on a fresh install; a no-op on every
 * subsequent boot (guarded by the presence of the `site` row).
 */
import { nanoid } from 'nanoid'
import type { DbClient } from './db/client'
import { createSite } from './repositories/setup'
import { createDataRow } from './repositories/data'
import { createNode } from '@core/page-tree'
import type { Page } from '@core/page-tree'
import { pageToCells } from '../src/core/data/pageFromRow'

export async function ensureBootstrapSite(db: DbClient): Promise<void> {
  const { rows } = await db<{ count: number }>`select count(*) as count from sites`
  if (Number(rows[0]?.count ?? 0) > 0) return

  await db.transaction(async (tx) => {
    await createSite(tx, 'My Site', {})
    const rootNode = createNode('base.body')
    const homePage: Page = {
      id: nanoid(),
      title: 'Home',
      slug: 'index',
      nodes: { [rootNode.id]: rootNode },
      rootNodeId: rootNode.id,
    }
    // No local owner exists at bootstrap — authorship is null until a Logto
    // user signs in and edits.
    await createDataRow(
      tx,
      { id: homePage.id, siteId: 'default', tableId: 'pages', cells: pageToCells(homePage), slug: homePage.slug },
      null,
    )
  })
}

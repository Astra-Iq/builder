import type { DbClient } from '../db/client'

export async function createSite(
  db: DbClient,
  name: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await db`
    insert into sites (id, name, slug, settings_json)
    values ('default', ${name}, 'default', ${settings})
    on conflict (id) do update
      set name = excluded.name,
          settings_json = excluded.settings_json,
          updated_at = current_timestamp
  `
}

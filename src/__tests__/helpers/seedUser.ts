import { nanoid } from 'nanoid'
import type { DbClient } from '../../../server/db/client'

/**
 * Seed a `users` row directly for tests that need an author/owner to attribute
 * content to. Identity is Logto-owned in production (there is no `createUser`
 * repository function any more — `upsertUserByLogtoSubject` provisions on
 * login), but tests still need a deterministic local row for FK/authorship.
 *
 * Mirrors the insert the removed `createUser` performed: an empty
 * `password_hash` sentinel and an `active` status. Unlike
 * `upsertUserByLogtoSubject` it accepts a fixed `id` (the bundle-transfer tests
 * reuse it as the actor id), defaulting to a generated one. Returns the id.
 */
export async function seedUser(
  db: DbClient,
  input: { id?: string; email: string; displayName?: string; roleId: string },
): Promise<string> {
  const id = input.id ?? nanoid()
  const email = input.email.trim()
  const emailNormalized = email.toLowerCase()
  const displayName = input.displayName?.trim() || email
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, status, role_id)
    values (${id}, ${email}, ${emailNormalized}, ${displayName}, ${''}, ${'active'}, ${input.roleId})
  `
  return id
}

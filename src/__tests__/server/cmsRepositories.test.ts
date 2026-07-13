import { describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'
import { createSite } from '../../../server/repositories/setup'
import { findUserById, upsertUserByLogtoSubject } from '../../../server/repositories/users'
import { createCustomRole, listRoles } from '../../../server/repositories/roles'
import { createSession, findUserBySessionHash, revokeSessionByHash } from '../../../server/auth/sessions'

describe('CMS repositories', () => {
  it('creates a default site row', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await createSite(db, 'Example Site', {})
      const { rows } = await db<{ name: string }>`select name from site where id = 'default'`
      expect(rows[0]?.name).toBe('Example Site')
    } finally {
      await cleanup()
    }
  })

  it('provisions a Logto identity, upserting by subject and normalizing email', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const id = await upsertUserByLogtoSubject(db, {
        subject: 'logto|abc',
        email: 'Owner@Example.com',
        displayName: 'Owner',
        roleId: 'member',
      })
      const user = await findUserById(db, id)
      expect(user).toMatchObject({
        id,
        email: 'Owner@Example.com',
        logtoSubject: 'logto|abc',
        role: { slug: 'member' },
      })

      // Re-login with the same subject updates in place (no duplicate row).
      const again = await upsertUserByLogtoSubject(db, {
        subject: 'logto|abc',
        email: 'owner@example.com',
        displayName: 'Owner Renamed',
        roleId: 'admin',
      })
      expect(again).toBe(id)
      const updated = await findUserById(db, id)
      expect(updated?.displayName).toBe('Owner Renamed')
      expect(updated?.role.slug).toBe('admin')
    } finally {
      await cleanup()
    }
  })

  it('lists built-in roles by rank before custom roles', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await createCustomRole(db, {
        name: 'Auditor',
        description: 'Reads audit activity.',
        capabilities: ['audit.read'],
      })

      expect((await listRoles(db)).map((role) => role.slug)).toEqual([
        'owner',
        'admin',
        'client',
        'member',
        'auditor',
      ])
    } finally {
      await cleanup()
    }
  })

  it('stores session token hashes and rejects revoked sessions', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const userId = await upsertUserByLogtoSubject(db, {
        subject: 'logto|session',
        email: 'owner@example.com',
        displayName: 'Owner',
        roleId: 'member',
      })
      await createSession(db, {
        idHash: 'abc123',
        userId,
        expiresAt: new Date('2030-01-01'),
        ipAddress: '127.0.0.1',
        userAgent: 'test',
      })

      expect(await findUserBySessionHash(db, 'abc123')).toMatchObject({ id: userId })
      await revokeSessionByHash(db, 'abc123')
      expect(await findUserBySessionHash(db, 'abc123')).toBeNull()
    } finally {
      await cleanup()
    }
  })
})

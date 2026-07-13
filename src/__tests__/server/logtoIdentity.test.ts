import { describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'
import { syncSystemRoles } from '../../../server/repositories/roles'
import {
  extractLogtoClaims,
  mapLogtoRoleToBuilderRole,
  provisionUserFromClaims,
} from '../../../server/auth/logtoIdentity'

describe('Logto identity mapping', () => {
  it('maps Logto role names onto builder roles, highest privilege first', () => {
    expect(mapLogtoRoleToBuilderRole(['owner'])).toBe('owner')
    expect(mapLogtoRoleToBuilderRole(['Admin'])).toBe('admin') // case-insensitive
    expect(mapLogtoRoleToBuilderRole(['client'])).toBe('client')
    expect(mapLogtoRoleToBuilderRole(['member'])).toBe('member')
    expect(mapLogtoRoleToBuilderRole(['admin', 'client'])).toBe('admin') // highest privilege wins
    expect(mapLogtoRoleToBuilderRole([])).toBe('member') // default
    expect(mapLogtoRoleToBuilderRole(['something-unknown'])).toBe('member')
  })

  it('extracts the claims the builder needs from an ID-token payload', () => {
    const claims = extractLogtoClaims({
      sub: 'u1',
      email: 'alice@example.com',
      name: 'Alice',
      picture: 'https://cdn/x.png',
      roles: ['admin'],
    })
    expect(claims).toEqual({
      subject: 'u1',
      email: 'alice@example.com',
      displayName: 'Alice',
      avatarUrl: 'https://cdn/x.png',
      roles: ['admin'],
    })
  })

  it('provisions a local identity from claims and re-syncs the role on re-login', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await syncSystemRoles(db)

      const user = await provisionUserFromClaims(db, {
        subject: 'logto|1',
        email: 'alice@example.com',
        displayName: 'Alice',
        avatarUrl: null,
        roles: ['admin'],
      })
      expect(user.role.slug).toBe('admin')
      expect(user.logtoSubject).toBe('logto|1')
      expect(user.capabilities).toContain('site.structure.edit')

      // Same subject on next login updates in place (no duplicate) and re-maps
      // the role from Logto.
      const again = await provisionUserFromClaims(db, {
        subject: 'logto|1',
        email: 'alice@example.com',
        displayName: 'Alice Renamed',
        avatarUrl: null,
        roles: ['client'],
      })
      expect(again.id).toBe(user.id)
      expect(again.displayName).toBe('Alice Renamed')
      expect(again.role.slug).toBe('client')
    } finally {
      await cleanup()
    }
  })
})

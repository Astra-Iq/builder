import { describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'
import { syncSystemRoles } from '../../../server/repositories/roles'
import {
  eligibleOrgs,
  extractLogtoClaims,
  mapOrgRoleToBuilderRole,
  provisionUserFromClaims,
} from '../../../server/auth/logtoIdentity'

describe('Logto identity mapping', () => {
  it('maps org role names onto builder roles; Viewer/unknown grant nothing', () => {
    expect(mapOrgRoleToBuilderRole('owner')).toBe('owner')
    expect(mapOrgRoleToBuilderRole('Admin')).toBe('admin') // case-insensitive
    expect(mapOrgRoleToBuilderRole('viewer')).toBeNull()
    expect(mapOrgRoleToBuilderRole('member')).toBeNull()
    expect(mapOrgRoleToBuilderRole('something-unknown')).toBeNull()
  })

  it('extracts org memberships from merged id-token + userinfo claims', () => {
    const claims = extractLogtoClaims({
      sub: 'u1',
      email: 'alice@example.com',
      name: 'Alice',
      picture: 'https://cdn/x.png',
      organization_data: [
        { id: 'org_a', name: 'Acme Store' },
        { id: 'org_b', name: 'Beta Boutique' },
      ],
      organization_roles: ['org_a:owner', 'org_b:viewer'],
    })
    expect(claims.subject).toBe('u1')
    expect(claims.email).toBe('alice@example.com')
    expect(claims.displayName).toBe('Alice')
    expect(claims.organizations).toEqual([
      { id: 'org_a', name: 'Acme Store', roles: ['owner'] },
      { id: 'org_b', name: 'Beta Boutique', roles: ['viewer'] },
    ])
  })

  it('eligibleOrgs keeps only Owner/Admin orgs, highest privilege each', () => {
    const claims = extractLogtoClaims({
      sub: 'u1',
      organization_data: [
        { id: 'org_a', name: 'Acme' },
        { id: 'org_b', name: 'Beta' },
        { id: 'org_c', name: 'Gamma' },
      ],
      organization_roles: ['org_a:admin', 'org_a:owner', 'org_b:viewer'],
    })
    expect(eligibleOrgs(claims)).toEqual([
      { orgId: 'org_a', name: 'Acme', builderRoleId: 'owner' }, // owner outranks admin
    ])
    // org_b is Viewer-only (denied); org_c has no role (denied).
  })

  it('provisions a local identity with a no-capability global baseline', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await syncSystemRoles(db)

      const user = await provisionUserFromClaims(db, {
        subject: 'logto|1',
        email: 'alice@example.com',
        displayName: 'Alice',
        avatarUrl: null,
        organizations: [{ id: 'org_a', name: 'Acme', roles: ['owner'] }],
      })
      // The global role is the member baseline (no caps) — real authorization is
      // per-site via site_members, assigned by the callback.
      expect(user.role.slug).toBe('member')
      expect(user.capabilities).toEqual([])
      expect(user.logtoSubject).toBe('logto|1')

      // Same subject on next login updates in place (no duplicate row).
      const again = await provisionUserFromClaims(db, {
        subject: 'logto|1',
        email: 'alice@example.com',
        displayName: 'Alice Renamed',
        avatarUrl: null,
        organizations: [],
      })
      expect(again.id).toBe(user.id)
      expect(again.displayName).toBe('Alice Renamed')
    } finally {
      await cleanup()
    }
  })
})

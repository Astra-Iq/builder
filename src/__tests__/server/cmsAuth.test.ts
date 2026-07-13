import { describe, expect, it } from 'bun:test'
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  hashSessionToken,
} from '../../../server/auth/tokens'

describe('CMS session token primitives', () => {
  it('generates opaque session tokens and stores only hashes', async () => {
    const token = createSessionToken()
    const hash = await hashSessionToken(token)
    expect(token.length).toBeGreaterThan(32)
    expect(hash).not.toBe(token)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('uses a stable admin session cookie name', () => {
    expect(SESSION_COOKIE_NAME).toBe('instatic_admin_session')
  })
})

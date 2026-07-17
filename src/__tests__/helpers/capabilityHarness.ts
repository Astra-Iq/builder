import { expect } from 'bun:test'
import type { CoreCapability } from '../../../server/auth/capabilities'
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  hashSessionToken,
  sessionExpiry,
} from '../../../server/auth/tokens'
import { createSession } from '../../../server/auth/sessions'
import { ensureBootstrapSite } from '../../../server/bootstrapSite'
import { syncSystemRoles, createCustomRole } from '../../../server/repositories/roles'
import { upsertUserByLogtoSubject } from '../../../server/repositories/users'
import type { DbClient } from '../../../server/db'
import { handleCmsRequest, type CmsHandlerOptions } from '../../../server/handlers/cms'
import { tryHandleAi } from '../../../server/ai/handlers'
import { createTestDb, type TestDb } from './createTestDb'

let harnessSerial = 0

interface HarnessRequestInit extends Omit<RequestInit, 'body'> {
  cookie?: string
  body?: BodyInit | null
  json?: unknown
}

interface TestRoleUser {
  cookie: string
  email: string
  roleId: string
}

/**
 * Auth in these tests no longer flows through a password login endpoint — Logto
 * owns authentication. The harness provisions identities + sessions directly
 * against the DB (the same primitives the OIDC callback uses at runtime:
 * `upsertUserByLogtoSubject` + `createSession`), then drives the CMS/AI handlers
 * with the resulting session cookie.
 */
export interface CapabilityTestHarness extends TestDb {
  cms(path: string, options?: HarnessRequestInit): Promise<Response>
  ai(path: string, options?: HarnessRequestInit): Promise<Response>
  setupOwner(): Promise<string>
  sessionForEmail(email: string): Promise<string>
  /**
   * Step-up is gone (Logto owns auth); the plain session cookie already
   * authorizes every action. Retained as a pass-through so call sites that
   * previously "stepped up" a cookie keep working unchanged.
   */
  stepUp(cookie: string): Promise<string>
  createRole(input: {
    name: string
    slug: string
    capabilities: CoreCapability[]
  }): Promise<string>
  createUser(input: {
    email: string
    displayName?: string
    roleId: string
  }): Promise<string>
  createRoleUser(input: {
    name: string
    slug: string
    capabilities: CoreCapability[]
    email?: string
    displayName?: string
  }): Promise<TestRoleUser>
}

function requestBody(options: HarnessRequestInit): BodyInit | null | undefined {
  if ('json' in options) return JSON.stringify(options.json)
  return options.body
}

function buildRequest(path: string, options: HarnessRequestInit = {}): Request {
  const headers = new Headers(options.headers)
  if ('json' in options && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const req = new Request(`http://localhost${path}`, {
    ...options,
    headers,
    body: requestBody(options),
  })
  if (options.cookie) req.headers.set('cookie', options.cookie)
  return req
}

export async function readJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

export async function expectForbidden(res: Response): Promise<void> {
  expect(res.status).toBe(403)
  const body = await readJson<{ error?: string }>(res)
  expect(body.error).toBe('Forbidden')
}

export function expectPastAuth(res: Response): void {
  expect(res.status).not.toBe(401)
  expect(res.status).not.toBe(403)
}

async function mintSession(db: DbClient, userId: string): Promise<string> {
  const token = createSessionToken()
  await createSession(db, {
    idHash: await hashSessionToken(token),
    userId,
    expiresAt: sessionExpiry(),
    ipAddress: null,
    userAgent: null,
    // The editor handlers resolve the tenant from the session's current site;
    // harness users edit the bootstrap 'default' site.
    currentSiteId: 'default',
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

export async function createCapabilityTestHarness(
  options: CmsHandlerOptions = {},
): Promise<CapabilityTestHarness> {
  const testDb = await createTestDb()
  const { db } = testDb
  const emailSuffix = `${Date.now()}-${++harnessSerial}`
  const ownerEmail = `owner-${emailSuffix}@example.com`
  let ownerCookie: string | null = null

  // Seed the built-in roles (owner/admin/client/member) with their capability
  // sets, exactly as the server does at boot.
  await syncSystemRoles(db)

  const cms = (path: string, requestOptions: HarnessRequestInit = {}) => {
    const req = buildRequest(path, requestOptions)
    return handleCmsRequest(req, db, options)
  }

  const ai = async (path: string, requestOptions: HarnessRequestInit = {}) => {
    const req = buildRequest(path, requestOptions)
    const response = await tryHandleAi(req, db, new URL(req.url))
    return response ?? new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
  }

  async function provisionUser(input: {
    email: string
    displayName?: string
    roleId: string
  }): Promise<string> {
    return upsertUserByLogtoSubject(db, {
      subject: `logto-${input.email}`,
      email: input.email,
      displayName: input.displayName ?? input.email,
      roleId: input.roleId,
    })
  }

  // Step-up removed with the Logto migration — return the cookie unchanged.
  async function stepUp(cookie: string): Promise<string> {
    return cookie
  }

  async function sessionForEmail(email: string): Promise<string> {
    const { rows } = await db<{ id: string }>`
      select id from users where email_normalized = ${email.trim().toLowerCase()} and deleted_at is null limit 1
    `
    const userId = rows[0]?.id
    if (!userId) throw new Error(`No user for ${email}`)
    return mintSession(db, userId)
  }

  async function setupOwner(): Promise<string> {
    // Bootstrap the default site + starter homepage (same as server boot), so
    // tests that read `/pages` see the seeded home page.
    await ensureBootstrapSite(db)
    const ownerId = await provisionUser({ email: ownerEmail, roleId: 'owner' })
    ownerCookie = await mintSession(db, ownerId)
    return ownerCookie
  }

  async function createRole(input: {
    name: string
    slug: string
    capabilities: CoreCapability[]
  }): Promise<string> {
    const role = await createCustomRole(db, {
      name: input.name,
      slug: input.slug,
      description: '',
      capabilities: input.capabilities,
    })
    return role.id
  }

  async function createUser(input: {
    email: string
    displayName?: string
    roleId: string
  }): Promise<string> {
    return provisionUser(input)
  }

  async function createRoleUser(input: {
    name: string
    slug: string
    capabilities: CoreCapability[]
    email?: string
    displayName?: string
  }): Promise<TestRoleUser> {
    const email = input.email ?? `${input.slug}-${emailSuffix}@example.com`
    const roleId = await createRole({
      name: input.name,
      slug: input.slug,
      capabilities: input.capabilities,
    })
    await createUser({ email, displayName: input.displayName ?? input.name, roleId })
    const cookie = await sessionForEmail(email)
    return { cookie, email, roleId }
  }

  // Keep `ownerCookie` referenced so lint doesn't flag the memo (used by
  // callers that expect a stable owner session across requests).
  void ownerCookie

  return {
    ...testDb,
    cms,
    ai,
    setupOwner,
    sessionForEmail,
    stepUp,
    createRole,
    createUser,
    createRoleUser,
  }
}

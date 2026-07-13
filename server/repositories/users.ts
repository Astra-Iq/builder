import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { placeholder, type DbClient } from '../db/client'
import { isoDateOrNull } from '@core/utils/isoDate'
import { normalizeCapabilities, type CoreCapability } from '../auth/capabilities'
import type { UserStatus } from '../types'

interface UserRole {
  id: string
  slug: string
  name: string
  description: string
  isSystem: boolean
  capabilities: CoreCapability[]
}

/**
 * The public identity view of a user. Since identities are owned by Logto,
 * this carries only what the builder renders/attributes: identity, role +
 * capabilities, avatar, and timestamps. Credentials (password/MFA) and the
 * local lockout/step-up policy fields are gone — Logto owns all of that.
 */
interface CmsUser {
  id: string
  email: string
  displayName: string
  status: UserStatus
  role: UserRole
  capabilities: CoreCapability[]
  lastLoginAt: string | null
  avatarMediaId: string | null
  /** Public path of the uploaded avatar (resolved from media_assets), or null. */
  avatarUrl: string | null
  /** SHA-256 hex of the normalized email — drives the Gravatar fallback URL. */
  gravatarHash: string
  createdAt: string
  updatedAt: string
}

export interface AuthUser extends CmsUser {
  /** The Logto subject this local identity shadows (null for legacy rows). */
  logtoSubject: string | null
  /**
   * The site the session is currently editing, or null when none is selected
   * (a multi-org user before they pick, or a user with no eligible site). Only
   * populated by the session-cookie hydration; null from `findUserById`.
   */
  currentSiteId: string | null
}

export interface JoinedUserRow {
  id: string
  email: string
  display_name: string
  status: UserStatus
  role_id: string
  logto_subject: string | null
  last_login_at: Date | string | null
  avatar_media_id: string | null
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
  role_slug: string
  role_name: string
  role_description: string
  role_is_system: boolean | number
  role_capabilities_json: unknown
  avatar_public_path: string | null
  /** Only selected by the session-cookie hydration; undefined elsewhere. */
  current_site_id?: string | null
}

/**
 * The user + role + avatar column list, defined exactly once. Every read that
 * hydrates an `AuthUser` (`findUserById` here plus the session-cookie lookup in
 * `server/auth/sessions.ts`) splices this into a `db.unsafe()` SELECT so the
 * hydrated column list lives in a single place. Capabilities flow from the
 * joined role's `capabilities_json` — the seam the Logto role mapping targets
 * (the callback assigns the mapped `role_id`; hydration is unchanged).
 */
export const USER_JOINED_COLUMNS = `users.id,
       users.email,
       users.display_name,
       users.status,
       roles.id as role_id,
       users.logto_subject,
       users.last_login_at,
       users.avatar_media_id,
       users.created_at,
       users.updated_at,
       users.deleted_at,
       roles.slug as role_slug,
       roles.name as role_name,
       roles.description as role_description,
       roles.is_system as role_is_system,
       roles.capabilities_json as role_capabilities_json,
       media_assets.public_path as avatar_public_path`

async function queryUsers(
  db: DbClient,
  clause: string,
  params: unknown[] = [],
): Promise<JoinedUserRow[]> {
  const { rows } = await db.unsafe<JoinedUserRow>(
    `select ${USER_JOINED_COLUMNS}
     from users
     join roles on roles.id = users.role_id
     left join media_assets on media_assets.id = users.avatar_media_id
     ${clause}`,
    params,
  )
  return rows
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * SHA-256 hex of the normalized email — drives the Gravatar fallback URL.
 * Recomputed on every read (cheap, always tracks `email`).
 */
export function computeGravatarHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex')
}

export function rowToUser(row: JoinedUserRow): AuthUser {
  const capabilities = normalizeCapabilities(row.role_capabilities_json)
  const role: UserRole = {
    id: row.role_id,
    slug: row.role_slug,
    name: row.role_name,
    description: row.role_description,
    isSystem: Boolean(row.role_is_system),
    capabilities,
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    role,
    capabilities,
    logtoSubject: row.logto_subject ?? null,
    currentSiteId: row.current_site_id ?? null,
    lastLoginAt: isoDateOrNull(row.last_login_at),
    avatarMediaId: row.avatar_media_id ?? null,
    avatarUrl: row.avatar_public_path ?? null,
    gravatarHash: computeGravatarHash(row.email),
    createdAt: isoDateOrNull(row.created_at)!,
    updatedAt: isoDateOrNull(row.updated_at)!,
  }
}

export function toPublicUser(user: AuthUser): CmsUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    role: user.role,
    capabilities: user.capabilities,
    lastLoginAt: user.lastLoginAt,
    avatarMediaId: user.avatarMediaId,
    avatarUrl: user.avatarUrl,
    gravatarHash: user.gravatarHash,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

export async function findUserById(db: DbClient, userId: string): Promise<AuthUser | null> {
  const rows = await queryUsers(
    db,
    `where users.id = ${placeholder(db.dialect, 1)} and users.deleted_at is null limit 1`,
    [userId],
  )
  return rows[0] ? rowToUser(rows[0]) : null
}

/**
 * Auto-provision (upsert) the local identity for a Logto subject. Updates the
 * email/display-name/role on every login so Logto stays authoritative; inserts
 * a fresh row (with an empty, never-verified `password_hash` sentinel) on first
 * sign-in. Returns the local user id.
 */
export async function upsertUserByLogtoSubject(
  db: DbClient,
  input: { subject: string; email: string; displayName: string; roleId: string },
): Promise<string> {
  const email = input.email.trim()
  const emailNormalized = normalizeEmail(email)
  const displayName = input.displayName.trim() || email

  const updated = await db`
    update users
    set email = ${email},
        email_normalized = ${emailNormalized},
        display_name = ${displayName},
        role_id = ${input.roleId},
        status = ${'active'},
        deleted_at = ${null},
        last_login_at = current_timestamp,
        updated_at = current_timestamp
    where logto_subject = ${input.subject}
  `
  if (updated.rowCount > 0) {
    const { rows } = await db<{ id: string }>`
      select id from users where logto_subject = ${input.subject} limit 1
    `
    if (rows[0]) return rows[0].id
  }

  const id = nanoid()
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, status, role_id, logto_subject, last_login_at)
    values (${id}, ${email}, ${emailNormalized}, ${displayName}, ${''}, ${'active'}, ${input.roleId}, ${input.subject}, current_timestamp)
  `
  return id
}

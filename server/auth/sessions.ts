import { placeholder, type DbClient } from '../db/client'
import { rowToUser, USER_JOINED_COLUMNS, type AuthUser, type JoinedUserRow } from '../repositories/users'
import { deriveDeviceLabel } from './deviceLabel'

const SESSION_IDLE_TIMEOUT_MS = 1000 * 60 * 60 * 24 * 30

/**
 * Debounce window for the per-request `last_seen_at` touch. Every authenticated
 * request used to fire an unconditional `update sessions set last_seen_at` —
 * a WAL-serialized write on SQLite, a hot-row lock on Postgres. The session
 * idle timeout is 30 days, so letting `last_seen_at` drift up to 30s stale is
 * functionally irrelevant; the in-memory tracker below collapses the write to
 * at most one per session per window.
 */
const LAST_SEEN_TOUCH_DEBOUNCE_MS = 30_000

/**
 * Hard cap on the tracker map so a long-running process that rotates through
 * many session hashes can't leak memory. When exceeded the map is cleared
 * wholesale — the only cost is one redundant `last_seen_at` write per active
 * session right after the reset.
 */
const LAST_SEEN_TRACKER_MAX_ENTRIES = 10_000

/** idHash -> epoch ms of the last `last_seen_at` write we issued for it. */
const lastSeenTouchedAt = new Map<string, number>()

function sessionIdleCutoff(now = Date.now()): Date {
  return new Date(now - SESSION_IDLE_TIMEOUT_MS)
}

/**
 * Create an opaque server session for an already-authenticated identity (the
 * OIDC callback mints one after verifying the Logto ID token). The session
 * cookie carries the raw token; only its hash (`idHash`) is stored.
 */
export async function createSession(
  db: DbClient,
  input: {
    idHash: string
    userId: string
    expiresAt: Date
    ipAddress: string | null
    userAgent: string | null
    /** Optional device label; falls back to a UA-derived label, then ''. */
    deviceLabel?: string
    /** The site this session starts editing (null until a multi-org user picks). */
    currentSiteId?: string | null
  },
): Promise<void> {
  const deviceLabel = input.deviceLabel ?? deriveDeviceLabel(input.userAgent)
  await db`
    insert into sessions (id_hash, user_id, expires_at, ip_address, user_agent, device_label, current_site_id)
    values (${input.idHash}, ${input.userId}, ${input.expiresAt}, ${input.ipAddress}, ${input.userAgent}, ${deviceLabel}, ${input.currentSiteId ?? null})
  `
}

/** Point a session at a different site (org switch). */
export async function setSessionCurrentSite(
  db: DbClient,
  idHash: string,
  siteId: string,
): Promise<void> {
  await db`
    update sessions set current_site_id = ${siteId} where id_hash = ${idHash}
  `
}

async function findSessionUserRow(
  db: DbClient,
  idHash: string,
  now = Date.now(),
): Promise<JoinedUserRow | null> {
  const idleCutoff = sessionIdleCutoff(now)
  const currentTime = new Date(now)
  // Joins through `sessions`, so it can't reuse the `queryUsers` FROM clause —
  // but it splices the same `USER_JOINED_COLUMNS` constant so the hydrated user
  // column list still lives in exactly one place.
  // Capabilities resolve from the CURRENT site's membership role: join
  // site_members on (current_site_id, user) and let the role join fall back to
  // the global `users.role_id` baseline when there is no membership (no site
  // selected, or access revoked) — the baseline is `member` (no capabilities),
  // so a user with no current site cannot act until they pick one.
  const { rows } = await db.unsafe<JoinedUserRow>(
    `select ${USER_JOINED_COLUMNS}, sessions.current_site_id as current_site_id
     from sessions
     join users on users.id = sessions.user_id
     left join site_members
       on site_members.site_id = sessions.current_site_id
      and site_members.user_id = users.id
     join roles on roles.id = coalesce(site_members.role_id, users.role_id)
     left join media_assets on media_assets.id = users.avatar_media_id
     where sessions.id_hash = ${placeholder(db.dialect, 1)}
       and sessions.revoked_at is null
       and sessions.expires_at > ${placeholder(db.dialect, 2)}
       and sessions.last_seen_at > ${placeholder(db.dialect, 3)}
       and users.status = ${placeholder(db.dialect, 4)}
       and users.deleted_at is null
     limit 1`,
    [idHash, currentTime, idleCutoff, 'active'],
  )
  return rows[0] ?? null
}

export async function findUserBySessionHash(
  db: DbClient,
  idHash: string,
  now = Date.now(),
): Promise<AuthUser | null> {
  const row = await findSessionUserRow(db, idHash, now)
  if (!row) return null
  const user = rowToUser(row)
  await touchSessionLastSeen(db, idHash, now)
  return user
}

/**
 * Update `sessions.last_seen_at` for an authenticated request, debounced to at
 * most once per `LAST_SEEN_TOUCH_DEBOUNCE_MS` per session. The first touch for
 * a hash always writes; subsequent touches inside the window are skipped.
 */
async function touchSessionLastSeen(db: DbClient, idHash: string, now: number): Promise<void> {
  const lastTouched = lastSeenTouchedAt.get(idHash)
  if (lastTouched !== undefined && now - lastTouched < LAST_SEEN_TOUCH_DEBOUNCE_MS) return

  if (lastSeenTouchedAt.size >= LAST_SEEN_TRACKER_MAX_ENTRIES) lastSeenTouchedAt.clear()
  lastSeenTouchedAt.set(idHash, now)
  await db`
    update sessions
    set last_seen_at = current_timestamp
    where id_hash = ${idHash}
  `
}

export async function revokeSessionByHash(db: DbClient, idHash: string): Promise<void> {
  await db`
    update sessions
    set revoked_at = current_timestamp
    where id_hash = ${idHash}
  `
}

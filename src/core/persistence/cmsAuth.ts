import {
  CmsPublicSiteSchema,
  type CmsPublicSite,
} from './responseSchemas'
import { Type, type Static } from '@sinclair/typebox'
import { apiRequest, ApiError, type FetchLike } from '@core/http'

const CmsCurrentUserRoleSchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  description: Type.String(),
  isSystem: Type.Boolean(),
  capabilities: Type.Array(Type.String()),
})

/**
 * The authenticated identity the admin app renders. Identities come from Logto,
 * so this carries only what the builder shows/attributes: identity, role +
 * capabilities, avatar, and timestamps. Credentials, MFA, and lockout/step-up
 * policy live in Logto and are not exposed here.
 */
export const CmsCurrentUserSchema = Type.Object({
  id: Type.String(),
  email: Type.String(),
  displayName: Type.String(),
  status: Type.Union([Type.Literal('active'), Type.Literal('suspended')]),
  role: CmsCurrentUserRoleSchema,
  capabilities: Type.Array(Type.String()),
  lastLoginAt: Type.Union([Type.String(), Type.Null()]),
  /**
   * Identifier of the media asset backing the avatar, or null when the user
   * relies on the Gravatar identicon fallback.
   */
  avatarMediaId: Type.Union([Type.String(), Type.Null()]),
  /**
   * Resolved public path of the avatar image when one is uploaded, otherwise
   * null. The Gravatar fallback URL is built client-side from `gravatarHash`.
   */
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
  /**
   * SHA-256 hex of the normalized email — drives the Gravatar identicon URL.
   * Always populated for authenticated users.
   */
  gravatarHash: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export type CmsCurrentUser = Static<typeof CmsCurrentUserSchema>

/** A site the signed-in user may edit, as returned by `/me`. */
export const CmsAvailableSiteSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  roleId: Type.String(),
  /**
   * Canonical public origin the site serves at (`https://<custom-domain>` or
   * `https://<slug>.<PUBLIC_BASE_DOMAIN>`), or null when per-host serving is
   * not configured and the site serves on the app's own origin.
   */
  liveOrigin: Type.Union([Type.String(), Type.Null()]),
})

export type CmsAvailableSite = Static<typeof CmsAvailableSiteSchema>

const CurrentUserEnvelope = Type.Object(
  {
    user: CmsCurrentUserSchema,
    role: Type.Optional(CmsCurrentUserRoleSchema),
    capabilities: Type.Optional(Type.Array(Type.String())),
    /** The site the session is editing, or null when none is selected. */
    currentSite: Type.Optional(Type.Union([CmsAvailableSiteSchema, Type.Null()])),
    /** Every site the user is a member of (empty => access unavailable). */
    availableSites: Type.Optional(Type.Array(CmsAvailableSiteSchema)),
  },
  { additionalProperties: true },
)

/** The authenticated identity plus the multi-tenant site context from `/me`. */
export interface CmsSession {
  user: CmsCurrentUser
  currentSite: CmsAvailableSite | null
  availableSites: CmsAvailableSite[]
}

/**
 * Read the unauthenticated site-identity (name + favicon URL) the sign-in
 * interstitial and admin brand row render. Safe to call before login; never
 * exposes a page tree or user data. Resolves to `{ name: null, faviconUrl:
 * null }` for a freshly-cloned install where no site exists yet.
 */
export async function getCmsPublicSite(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPublicSite> {
  return apiRequest(`${basePath}/public-site`, {
    schema: CmsPublicSiteSchema,
    fetchImpl,
    fallbackMessage: 'CMS public site identity request failed',
  })
}

export async function probeCmsSession(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<boolean> {
  try {
    await apiRequest(`${basePath}/me`, { fetchImpl, fallbackMessage: 'CMS session check failed' })
    return true
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return false
    throw err
  }
}

export async function getCurrentCmsUser(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser> {
  const body = await apiRequest(`${basePath}/me`, {
    schema: CurrentUserEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS current user request failed',
  })
  return body.user
}

/**
 * Read the full authenticated session: the identity plus the multi-tenant site
 * context (which site is active and which sites the user may edit). Drives the
 * org-picker / access-unavailable states in the admin boot.
 */
export async function getCurrentCmsSession(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsSession> {
  const body = await apiRequest(`${basePath}/me`, {
    schema: CurrentUserEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS current user request failed',
  })
  return {
    user: body.user,
    currentSite: body.currentSite ?? null,
    availableSites: body.availableSites ?? [],
  }
}

const SwitchSiteResultSchema = Type.Object({ ok: Type.Boolean(), siteId: Type.String() })

/** Point the session at another site the user is a member of, then it can reload. */
export async function switchCmsSite(
  siteId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  await apiRequest(`${basePath}/session/switch-site`, {
    method: 'POST',
    body: { siteId },
    schema: SwitchSiteResultSchema,
    fetchImpl,
    fallbackMessage: 'Switching site failed',
  })
}

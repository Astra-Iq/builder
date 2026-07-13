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

const CurrentUserEnvelope = Type.Object(
  {
    user: CmsCurrentUserSchema,
    role: Type.Optional(CmsCurrentUserRoleSchema),
    capabilities: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
)

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

import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  getCmsPublicSite,
  getCurrentCmsSession,
  type CmsCurrentUser,
  type CmsPublicSite,
  type CmsAvailableSite,
} from '@core/persistence/auth'

/**
 * The admin app authenticates through Logto (the builder is the OIDC client).
 * On mount we probe `/me`:
 *   - a valid session → `authenticated` (render the editor)
 *   - no / expired session (401) → `unauthenticated`; the browser is
 *     redirected to `/admin/api/cms/auth/login`, which bounces to Logto.
 *
 * There is no in-app login/setup/MFA form anymore — this hook either hands the
 * app an authenticated user or sends the browser to Logto.
 *
 * Pre-flighted boot probes (see server/static.ts `BOOT_API_KICKOFF`) start the
 * `/me` + `/public-site` fetches at HTML-parse time and expose the promises on
 * `window.__instaticBootPromises`; when present we consume them instead of
 * issuing our own fetches.
 */
const LOGIN_URL = '/admin/api/cms/auth/login'

interface PreflightedBootPromises {
  me: Promise<{ ok: true; user: CmsCurrentUser } | { ok: false }>
  publicSite: Promise<CmsPublicSite | null>
}

function readPreflightedBootPromises(): PreflightedBootPromises | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as unknown as { __instaticBootPromises?: unknown }).__instaticBootPromises
  if (!candidate || typeof candidate !== 'object') return null
  const c = candidate as Record<string, unknown>
  if (!('me' in c) || !('publicSite' in c)) return null
  return c as unknown as PreflightedBootPromises
}

function redirectToLogin(): void {
  if (typeof window !== 'undefined') window.location.assign(LOGIN_URL)
}

/**
 * Boot outcomes:
 *   - `authenticated`  — signed in with a current site → render the editor.
 *   - `needs-site`     — signed in, member of 2+ sites, none chosen → org picker.
 *   - `no-access`      — signed in but not an Owner/Admin of any org → denial.
 *   - `unauthenticated`— no session; the browser is redirected to Logto.
 */
export type AdminBootStatus =
  | 'loading'
  | 'authenticated'
  | 'needs-site'
  | 'no-access'
  | 'unauthenticated'

interface AdminBootResult {
  status: AdminBootStatus
  currentUser: CmsCurrentUser | null
  availableSites: CmsAvailableSite[]
  publicSite: CmsPublicSite
}

const DEFAULT_PUBLIC_SITE: CmsPublicSite = { name: null, faviconUrl: null }

export function useAdminBoot(): AdminBootResult {
  const [status, setStatus] = useState<AdminBootStatus>('loading')
  const [currentUser, setCurrentUser] = useState<CmsCurrentUser | null>(null)
  const [availableSites, setAvailableSites] = useState<CmsAvailableSite[]>([])
  const [publicSite, setPublicSite] = useState<CmsPublicSite>(DEFAULT_PUBLIC_SITE)

  useEffect(() => {
    let cancelled = false
    const preflighted = readPreflightedBootPromises()

    const publicSitePromise = preflighted?.publicSite ?? getCmsPublicSite().catch(() => null)
    void publicSitePromise.then((next) => {
      if (cancelled || next === null) return
      setPublicSite(next)
    })

    async function resolveAuth(): Promise<void> {
      // The full session carries the multi-tenant context (which sites the user
      // may edit, and which one is active) that decides editor vs picker vs
      // denial — so we read it directly rather than the identity-only preflight.
      try {
        const session = await getCurrentCmsSession()
        if (cancelled) return
        // flushSync — force the initial boot commit synchronous so the resolved
        // screen paints on the frame /me settles rather than waiting on the
        // concurrent scheduler. Only this first commit is forced.
        flushSync(() => {
          setCurrentUser(session.user)
          setAvailableSites(session.availableSites)
          if (session.currentSite) setStatus('authenticated')
          else if (session.availableSites.length > 0) setStatus('needs-site')
          else setStatus('no-access')
        })
      } catch {
        if (cancelled) return
        flushSync(() => setStatus('unauthenticated'))
        redirectToLogin()
      }
    }

    void resolveAuth()
    return () => { cancelled = true }
  }, [])

  return { status, currentUser, availableSites, publicSite }
}

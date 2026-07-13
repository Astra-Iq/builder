import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  getCmsPublicSite,
  getCurrentCmsUser,
  type CmsCurrentUser,
  type CmsPublicSite,
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

export type AdminBootStatus = 'loading' | 'authenticated' | 'unauthenticated'

interface AdminBootResult {
  status: AdminBootStatus
  currentUser: CmsCurrentUser | null
  publicSite: CmsPublicSite
}

const DEFAULT_PUBLIC_SITE: CmsPublicSite = { name: null, faviconUrl: null }

export function useAdminBoot(): AdminBootResult {
  const [status, setStatus] = useState<AdminBootStatus>('loading')
  const [currentUser, setCurrentUser] = useState<CmsCurrentUser | null>(null)
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
      try {
        const mePromise: Promise<{ ok: true; user: CmsCurrentUser } | { ok: false }> =
          preflighted?.me
            ?? getCurrentCmsUser().then(
              (user) => ({ ok: true as const, user }),
              () => ({ ok: false as const }),
            )
        const result = await mePromise
        if (cancelled) return

        // flushSync — force the boot commit synchronous so the editor paints on
        // the frame the /me promise resolves rather than sitting behind the
        // concurrent scheduler for 200–300ms. Subsequent transitions still flow
        // through the concurrent scheduler; only this initial commit is forced.
        if (result.ok) {
          flushSync(() => {
            setCurrentUser(result.user)
            setStatus('authenticated')
          })
        } else {
          flushSync(() => setStatus('unauthenticated'))
          redirectToLogin()
        }
      } catch {
        if (cancelled) return
        flushSync(() => setStatus('unauthenticated'))
        redirectToLogin()
      }
    }

    void resolveAuth()
    return () => { cancelled = true }
  }, [])

  return { status, currentUser, publicSite }
}

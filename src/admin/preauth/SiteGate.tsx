/**
 * Multi-tenant boot gates, shown between a successful Logto sign-in and the
 * editor:
 *   - `SitePicker` — the signed-in user administers more than one organization
 *     and has not yet chosen which site to edit. Picking one points the session
 *     at that site (`switchCmsSite`) and reloads into the editor.
 *   - `AccessUnavailable` — the user is authenticated but is not an Owner/Admin
 *     of any organization, so there is no site to edit. Their only action is to
 *     sign out (and sign in with a different account).
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { switchCmsSite, type CmsAvailableSite } from '@core/persistence/auth'
import { getErrorMessage } from '@core/utils/errorMessage'
import styles from './SiteGate.module.css'

const LOGOUT_URL = '/admin/api/cms/auth/logout'
const EDITOR_URL = '/admin/site'

export function SitePicker({ sites }: { sites: readonly CmsAvailableSite[] }) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function choose(site: CmsAvailableSite): Promise<void> {
    setPendingId(site.id)
    setError(null)
    try {
      await switchCmsSite(site.id)
      window.location.assign(EDITOR_URL)
    } catch (err) {
      setError(getErrorMessage(err, 'Could not open that site'))
      setPendingId(null)
    }
  }

  return (
    <div className={styles.screen}>
      <div className={styles.panel}>
        <h1 className={styles.title}>Choose a workspace</h1>
        <p className={styles.subtitle}>You administer more than one organization. Pick the site to edit.</p>
        <ul className={styles.siteList}>
          {sites.map((site) => (
            <li key={site.id}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => { void choose(site) }}
                disabled={pendingId !== null}
                className={styles.siteButton}
              >
                <span className={styles.siteName}>{site.name}</span>
              </Button>
            </li>
          ))}
        </ul>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.footer}>
          <Button type="button" variant="ghost" size="sm" onClick={() => { window.location.assign(LOGOUT_URL) }}>
            <span>Sign out</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

export function AccessUnavailable() {
  return (
    <div className={styles.screen}>
      <div className={styles.panel}>
        <h1 className={styles.title}>Access unavailable</h1>
        <p className={styles.subtitle}>
          Your account is not an Owner or Admin of any organization, so there is no site to edit.
          Ask an organization owner for access, or sign in with a different account.
        </p>
        <div className={styles.footer}>
          <Button type="button" variant="secondary" size="sm" onClick={() => { window.location.assign(LOGOUT_URL) }}>
            <span>Sign out</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

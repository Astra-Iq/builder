/**
 * AccountPage — `/admin/account`.
 *
 * Self-targeted identity page. Every authenticated user sees the same read-only
 * view: name, email, and role come from Logto (via the `/me` claims-derived
 * identity), so there is nothing to edit here — profile, password, MFA, and
 * device/session management all live in Logto's account center.
 *
 * The one action is sign out: an RP-initiated logout that clears the local
 * session and hands off to Logto's end-session endpoint.
 */
import { Button } from '@ui/components/Button'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import styles from './AccountPage.module.css'

const LOGOUT_URL = '/admin/api/cms/auth/logout'

export function AccountPage() {
  // Rendered inside the authenticated branch of `AdminEntry`, so a session user
  // is guaranteed; the strict variant throws if that contract is violated.
  const user = useAuthenticatedAdminUser()

  return (
    <AdminPageLayout
      workspace="account"
      title="Account"
      titleId="account-title"
      description="Your identity is managed in Logto."
    >
      <div className={styles.body}>
        <dl className={styles.profileFields}>
          <div className={styles.profileField}>
            <dt className={styles.profileFieldLabel}>Name</dt>
            <dd className={styles.profileFieldValue}>{user.displayName}</dd>
          </div>
          <div className={styles.profileField}>
            <dt className={styles.profileFieldLabel}>Email</dt>
            <dd className={styles.profileFieldValue}>{user.email}</dd>
          </div>
          <div className={styles.profileField}>
            <dt className={styles.profileFieldLabel}>Role</dt>
            <dd className={styles.profileFieldValue}>{user.role.name}</dd>
          </div>
        </dl>

        <div className={styles.profileActions}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => { window.location.assign(LOGOUT_URL) }}
          >
            <span>Sign out</span>
          </Button>
        </div>
      </div>
    </AdminPageLayout>
  )
}

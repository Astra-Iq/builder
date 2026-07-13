/**
 * AdminSectionNavigation — the row of section links shown inside the
 * editor toolbar (Site · Content · Data · Media).
 *
 * Lives next to the toolbar styles it consumes so both the heavy
 * AdminCanvasLayout (Site), AdminWorkspaceCanvasLayout (Content / Data /
 * Media), and the lightweight AdminPageLayout (Account) can share it
 * without one layout pulling another layout's module graph in.
 */
import { type MouseEvent, type ReactNode } from 'react'
import { ArticleSolidIcon } from 'pixel-art-icons/icons/article-solid'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import type { CmsCurrentUser } from '@core/persistence'
import { Link, useLocation } from '@admin/lib/routing'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { canAccessWorkspace } from '@admin/access'
import type { AdminWorkspace } from '@admin/workspace'
import toolbarStyles from '@site/toolbar/Toolbar.module.css'

/**
 * Pixel-art icon used inside an admin nav link. Sized to match the
 * 11px nav-label cap-height — the 13px box leaves the icon visually
 * balanced with the text without crowding the 28px button track.
 */
const NAV_ICON_SIZE = 13

interface AdminSectionNavigationProps {
  section: AdminWorkspace
  currentUser?: CmsCurrentUser | null
  onWorkspaceNavigateStart?: () => unknown
}

export function AdminSectionNavigation({
  section,
  currentUser,
  onWorkspaceNavigateStart,
}: AdminSectionNavigationProps) {
  const sessionUser = useCurrentAdminUser()
  const effectiveUser = currentUser ?? sessionUser ?? null
  const unrestricted = !effectiveUser
  const canAccess = (workspace: AdminWorkspace) => unrestricted || canAccessWorkspace(effectiveUser, workspace)

  return (
    <>
      {canAccess('site') && (
        <NavItem
          to="/admin/site"
          icon={<LayoutSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
          label="Site"
          active={section === 'site'}
          onNavigateStart={onWorkspaceNavigateStart}
        />
      )}
      {canAccess('content') && (
        <NavItem
          to="/admin/content"
          icon={<ArticleSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
          label="Content"
          active={section === 'content'}
          onNavigateStart={onWorkspaceNavigateStart}
        />
      )}
      {canAccess('data') && (
        <NavItem
          to="/admin/data"
          icon={<DatabaseSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
          label="Data"
          active={section === 'data'}
          onNavigateStart={onWorkspaceNavigateStart}
        />
      )}
      {canAccess('media') && (
        <NavItem
          to="/admin/media"
          icon={<ImagesSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
          label="Media"
          active={section === 'media'}
          onNavigateStart={onWorkspaceNavigateStart}
        />
      )}
    </>
  )
}

/**
 * Single first-party admin nav slot. Renders the icon + label as the
 * non-clickable `activeSection` span when the user is already on that
 * workspace, otherwise as a soft-navigating `AdminRouteLink`.
 */
function NavItem({
  to,
  icon,
  label,
  active,
  onNavigateStart,
}: {
  to: string
  icon: ReactNode
  label: string
  active: boolean
  onNavigateStart?: () => unknown
}) {
  if (active) {
    return (
      <span className={toolbarStyles.activeSection}>
        {icon}
        <span>{label}</span>
      </span>
    )
  }
  return (
    <AdminRouteLink to={to} onNavigateStart={onNavigateStart}>
      {icon}
      <span>{label}</span>
    </AdminRouteLink>
  )
}

/**
 * Soft-navigating admin nav link. Always rendered inside the admin Router
 * (the admin shell unconditionally mounts one), so we don't fork into a
 * router-vs-static branch — calling `useAdminNavigate` here is always safe.
 */
function AdminRouteLink({
  to,
  children,
  onNavigateStart,
}: {
  to: string
  children: ReactNode
  onNavigateStart?: () => unknown
}) {
  const navigate = useAdminNavigate()
  const location = useLocation()

  async function navigateToAdminRoute(event: MouseEvent<HTMLAnchorElement>) {
    // Modifier keys / non-primary buttons / target=_blank → let the native
    // <a> behaviour run (open-in-new-tab, etc.). Same-page clicks are a
    // no-op so the soft transition doesn't replay needlessly.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.currentTarget.target
    ) {
      return
    }

    if (location.pathname === to) return

    event.preventDefault()
    try {
      const result = onNavigateStart?.()
      if (isPromiseLike(result)) await result
      navigate(to)
    } catch (err) {
      console.error('[AdminSectionNavigation] Navigation start hook failed:', err)
    }
  }

  return (
    <Link className={toolbarStyles.adminLink} to={to} onClick={navigateToAdminRoute}>
      {children}
    </Link>
  )
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'object' || value === null) return false
  if (!('then' in value)) return false
  return typeof (value as { then: unknown }).then === 'function'
}

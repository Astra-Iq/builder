/**
 * AccountMenuButton — toolbar avatar dropdown.
 *
 * Verifies:
 *   - Trigger displays initials derived from displayName, falling back to
 *     email when displayName is empty.
 *   - Opening the menu shows the user's display name, email, and role label,
 *     plus the two actions (Account, Sign out).
 *   - "Sign out" hard-navigates to the Logto logout route.
 *   - "Account & security" soft-navigates to /admin/account via the router.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AccountMenuButton } from '@admin/shared/AccountMenuButton'
import { AdminSessionProvider } from '@admin/session'
import { MemoryRouter, Route, Routes, useLocation } from '@admin/lib/routing'
import type { CmsCurrentUser } from '@core/persistence'

const now = '2026-05-09T10:00:00.000Z'
const originalLocation = window.location

function makeUser(overrides: Partial<CmsCurrentUser> = {}): CmsCurrentUser {
  return {
    id: 'owner_1',
    email: 'owner@example.com',
    displayName: 'Olivia Owner',
    status: 'active',
    role: {
      id: 'owner',
      slug: 'owner',
      name: 'Owner',
      description: '',
      isSystem: true,
      capabilities: ['site.read'],
    },
    capabilities: ['site.read'],
    lastLoginAt: null,
    avatarMediaId: null,
    avatarUrl: null,
    // Empty hash → no Gravatar URL → initials fallback fires.
    gravatarHash: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function renderWithUser(user: CmsCurrentUser) {
  return render(
    <MemoryRouter initialEntries={['/admin/site']}>
      <AdminSessionProvider user={user}>
        <AccountMenuButton />
      </AdminSessionProvider>
    </MemoryRouter>,
  )
}

describe('AccountMenuButton', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, assign: mock(() => {}) },
    })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    })
  })

  it('uses the first letter of the display name for the initials', () => {
    renderWithUser(makeUser({ displayName: 'Alice Admin' }))
    const trigger = screen.getByTestId('account-menu-trigger')
    expect(trigger.textContent?.trim()).toBe('A')
    expect(trigger.getAttribute('aria-label')).toContain('Alice Admin')
  })

  it('falls back to the email when displayName is empty', () => {
    renderWithUser(makeUser({ displayName: '', email: 'me@example.com' }))
    const trigger = screen.getByTestId('account-menu-trigger')
    expect(trigger.textContent?.trim()).toBe('M')
  })

  it('opens a dropdown with the user header and the two actions', () => {
    renderWithUser(makeUser())
    fireEvent.click(screen.getByTestId('account-menu-trigger'))

    expect(screen.getByText('Olivia Owner')).toBeTruthy()
    expect(screen.getByText('owner@example.com')).toBeTruthy()
    expect(screen.getByText('Owner')).toBeTruthy()
    expect(screen.getByTestId('account-menu-go-to-account')).toBeTruthy()
    expect(screen.getByTestId('account-menu-sign-out')).toBeTruthy()
  })

  it('navigates to the Logto logout route on sign out', () => {
    const assignSpy = window.location.assign as ReturnType<typeof mock>

    renderWithUser(makeUser())
    fireEvent.click(screen.getByTestId('account-menu-trigger'))
    fireEvent.click(screen.getByTestId('account-menu-sign-out'))

    expect(assignSpy).toHaveBeenCalledWith('/admin/api/cms/auth/logout')
  })

  it('"Account & security" navigates to /admin/account via the router', async () => {
    const assignSpy = window.location.assign as ReturnType<typeof mock>
    function PathProbe() {
      return <span data-testid="probe-pathname">{useLocation().pathname}</span>
    }

    render(
      <MemoryRouter initialEntries={['/admin/site']}>
        <AdminSessionProvider user={makeUser()}>
          <AccountMenuButton />
          <Routes>
            <Route path="/admin/site" element={<PathProbe />} />
            <Route path="/admin/account" element={<PathProbe />} />
          </Routes>
        </AdminSessionProvider>
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTestId('account-menu-trigger'))
    fireEvent.click(screen.getByTestId('account-menu-go-to-account'))

    await waitFor(() => {
      expect(screen.getByTestId('probe-pathname').textContent).toBe('/admin/account')
    })
    expect(assignSpy).not.toHaveBeenCalled()
  })
})

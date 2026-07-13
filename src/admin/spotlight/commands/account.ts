/**
 * Account commands — §4.13 of the Command Spotlight master plan.
 *
 * Sign out (destructive), navigate to account settings sections.
 */

import type { Command } from '../types'

// GET route: revokes the local session and hands off to Logto's end-session
// endpoint. Navigated to directly (hard navigation) so the redirect runs.
const LOGOUT_URL = '/admin/api/cms/auth/logout'

export function getAccountCommands(): Command[] {
  return [
    {
      id: 'account.profile',
      title: 'Account',
      subtitle: 'View your identity',
      group: 'account',
      iconName: 'cursor-minimal-solid',
      keywords: ['account', 'profile', 'identity', 'name', 'email'],
      workspaces: ['any'],
      run: (ctx) => {
        ctx.closeSpotlight()
        ctx.navigate('/admin/account')
      },
    },

    {
      id: 'account.signOut',
      title: 'Sign out',
      subtitle: 'End your session and sign out of Logto',
      group: 'account',
      iconName: 'power-off',
      keywords: ['sign out', 'logout', 'log out', 'session', 'exit'],
      workspaces: ['any'],
      destructive: true,
      run: (ctx) => {
        ctx.closeSpotlight()
        window.location.assign(LOGOUT_URL)
      },
    },
  ]
}

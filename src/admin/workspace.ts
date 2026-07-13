/**
 * AdminWorkspace — top-level admin section identifier.
 *
 * Defined here (not in a concrete layout) so editor chrome (e.g. Toolbar)
 * can reference the type without creating cycles through layout modules.
 */
/**
 * `'site'` is the admin home — the visual editor every user lands on.
 *
 * `'account'` is the user's own settings page (profile, devices, security,
 * activity). Self-targeted — no capability gate; every authenticated user
 * can access their own. The avatar dropdown in the toolbar is the primary
 * entry point.
 */
/**
 * `'ai'` is the AI provider settings + defaults workspace. Gated by
 * `ai.providers.manage` (or `ai.audit.read` for the read-only audit tab).
 */
export type AdminWorkspace =
  | 'site'
  | 'content'
  | 'data'
  | 'media'
  | 'plugins'
  | 'ai'
  | 'pluginPage'
  | 'account'

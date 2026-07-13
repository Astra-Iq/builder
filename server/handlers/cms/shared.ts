/**
 * Shared helpers used by every handler in `server/handlers/cms/*`.
 *
 * `requestAuditContext` — the `(ipAddress, userAgent)` pair every audit event
 * carries. Kept intentionally small and dependency-free so any new handler
 * module can pull it in without dragging the rest of the CMS surface along.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { clientIp } from '../../auth/security'

export const CMS_API_PREFIX = '/admin/api/cms'

export const UserStatusSchema = Type.Union([Type.Literal('active'), Type.Literal('suspended')])

export interface CmsHandlerOptions {
  uploadsDir?: string
  /**
   * The raw `DATABASE_URL` the server booted with. Forwarded so handlers
   * that need to resolve the on-disk SQLite file (e.g. the storage
   * dashboard widget) can do so without re-parsing `process.env`. Postgres
   * URLs are passed verbatim — handlers that care about dialect should
   * branch on `db.dialect` instead of inspecting the URL themselves.
   */
  databaseUrl?: string
}

export function requestAuditContext(req: Request): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  }
}

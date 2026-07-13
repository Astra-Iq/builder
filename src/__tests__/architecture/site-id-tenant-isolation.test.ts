/**
 * Architecture Source-Scan — `site_id` tenant isolation
 *
 * The builder is multi-tenant on a SHARED schema: one database, a `site_id`
 * tenant key on every tenant-scoped table (one Logto Organization = one site).
 * Shared-schema's one real danger is a query that forgets `site_id` and leaks
 * one tenant's content into another's editor. This gate makes that footgun a
 * CI failure rather than a matter of discipline, locking in the isolation that
 * shipped for the content-row layer.
 *
 * ── What this gate enforces ────────────────────────────────────────────────
 * Two things, both scoped to `data_rows` — the table that carries every page,
 * post, component, and layout, and the highest-value cross-tenant leak target:
 *
 *   1. INSERTS. Every `insert into data_rows (…)` must list the `site_id`
 *      column. A row inserted without a tenant key is orphaned — invisible to
 *      scoped reads and a collision risk against the `(coalesce(site_id,''), …)`
 *      unique indexes. This is the unrecoverable footgun, so it is absolute.
 *
 *   2. TABLE-ENUMERATING READS/UPDATES. Any SQL literal that filters
 *      `data_rows` by `table_id` (i.e. "give me the rows in table X") must also
 *      reference `site_id`. Without it, "all rows in `pages`" returns every
 *      tenant's pages. Queries keyed purely by a primary-key `id` handle are
 *      exempt: the id was already resolved within a site-scoped read, so it is
 *      a trusted handle, not an enumeration.
 *
 * ── What this gate does NOT yet enforce ────────────────────────────────────
 * Isolation is being rolled out per subsystem. The content-row layer (this
 * table) is done; the media, plugin, AI, publish-redirect, versioning, and
 * snapshot subsystems still run effectively single-tenant and are tracked in
 * `ISOLATION_PENDING` below. A `data_rows` query that is deliberately still
 * cross-site (the plugin content-filter surface, the row-move slug check) is
 * listed in `PENDING_QUERY_ALLOWLIST` with a reason — and the gate fails if
 * such an entry becomes stale (the query got scoped or removed), so the
 * pending list can only shrink as isolation lands.
 *
 * The registry (`ISOLATION_ENFORCED` ∪ `ISOLATION_PENDING`) is checked against
 * the tables the migrations actually add `site_id` to, so a new tenant-scoped
 * table cannot be introduced without classifying it here.
 *
 * @see server/db/migrations-sqlite.ts — the `add column site_id` source of truth
 * @see docs/plans/multi-tenancy.md    — the shared-schema design + phase plan
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { extname, join, relative } from 'path'

const PROJECT_ROOT = join(import.meta.dir, '../../../')
const REPO_ROOT = join(PROJECT_ROOT, 'server/repositories')
const MIGRATION_FILE = join(PROJECT_ROOT, 'server/db/migrations-sqlite.ts')

// ---------------------------------------------------------------------------
// Tenant-scoped table registry
// ---------------------------------------------------------------------------

/**
 * The tables the migrations add a `site_id` column to — the authoritative set
 * of tenant-scoped tables. Parsed from the SQLite migration file so the
 * registry below cannot silently drift from the schema.
 */
function tenantScopedTablesFromMigration(): Set<string> {
  const src = readFileSync(MIGRATION_FILE, 'utf8')
  const tables = new Set<string>()
  const re = /alter table (\w+) add column site_id\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) tables.add(m[1])
  return tables
}

/** Tenant-scoped tables whose repository queries this gate enforces. */
const ISOLATION_ENFORCED = new Set<string>(['data_rows'])

/**
 * Tenant-scoped tables whose isolation is deferred to a later phase. They carry
 * a `site_id` column (so the groundwork is laid) but their repository queries
 * are not yet gated — those subsystems still operate effectively single-tenant.
 * Moving a table from here to `ISOLATION_ENFORCED` is what "we isolated the X
 * subsystem" looks like as a diff.
 */
const ISOLATION_PENDING = new Set<string>([
  'data_tables',
  'data_row_versions',
  'data_row_redirects',
  'site_snapshots',
  'published_runtime_assets',
  'media_assets',
  'media_folders',
  'media_asset_folders',
  'media_smart_folders',
  'media_usage_refs',
  'installed_plugins',
  'plugin_records',
  'plugin_crash_events',
  'plugin_schedules',
  'plugin_schedule_runs',
  'plugin_secrets',
  'ai_conversations',
  'ai_messages',
  'ai_mcp_connectors',
  'ai_defaults',
  'audit_events',
])

// ---------------------------------------------------------------------------
// Allowlist — `data_rows` queries that are deliberately still cross-site
// ---------------------------------------------------------------------------

interface PendingQuery {
  /** Repo-relative file the query lives in. */
  file: string
  /** A distinctive substring of the offending SQL literal. */
  needle: string
  /** Why it is not yet site-scoped, and what phase will fix it. */
  reason: string
}

const PENDING_QUERY_ALLOWLIST: PendingQuery[] = [
  {
    file: 'server/repositories/data/rows/filter.ts',
    needle: 'data_rows.table_id = ${placeholder(db.dialect, 1)} and data_rows.deleted_at is null',
    reason:
      'listDataRowsWithFilter powers the plugin `api.cms.content.*` filter surface, which is ' +
      'not yet tenant-scoped (pending the plugin-subsystem tenancy phase — installed_plugins et al. ' +
      'are still in ISOLATION_PENDING).',
  },
  {
    file: 'server/repositories/data/rows/mutations.ts',
    needle: 'and id <> ${rowId}',
    reason:
      'updateDataRowTable slug-conflict check — the row-move endpoint does not yet thread siteId; ' +
      'the conflict scan is cross-site until it does (pending editor-secondary-flow tenancy phase).',
  },
]

// ---------------------------------------------------------------------------
// File walker + SQL template-literal extraction
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (extname(entry) === '.ts' && !entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/** Blank a matched region to spaces, preserving newlines so nothing shifts. */
function blank(match: string): string {
  return match.replace(/[^\n]/g, ' ')
}

/**
 * Strip JS comments so backticks inside JSDoc / line comments (e.g. the
 * documented `` `from data_rows` `` in mapper.ts) can't mis-pair the template
 * scanner. The line-comment strip guards `://` so a URL inside a real literal
 * is never mistaken for a comment.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/gm, (full, prefix: string) => prefix + blank(full.slice(prefix.length)))
}

/**
 * Extract every backtick template literal from a source file. `${…}`
 * interpolations are preserved verbatim (with brace-depth tracking, so a `}` in
 * nested code doesn't close early) — the enforcement regexes key on the `${`
 * boundary, so it must survive.
 */
function extractTemplateLiterals(src: string): string[] {
  const s = stripComments(src)
  const out: string[] = []
  const n = s.length
  let i = 0
  while (i < n) {
    if (s[i] !== '`') {
      i++
      continue
    }
    i++ // past opening backtick
    let buf = ''
    while (i < n && s[i] !== '`') {
      if (s[i] === '$' && s[i + 1] === '{') {
        buf += '${'
        i += 2
        let depth = 1
        while (i < n && depth > 0) {
          const c = s[i]
          if (c === '{') depth++
          else if (c === '}') depth--
          if (depth > 0) buf += c
          i++
        }
        buf += '}'
      } else {
        buf += s[i]
        i++
      }
    }
    out.push(buf)
    i++ // past closing backtick
  }
  return out
}

// ---------------------------------------------------------------------------
// Enforcement predicates (scoped to `data_rows`)
// ---------------------------------------------------------------------------

const DATA_ROWS_RE = /\bdata_rows\b/i
const INSERT_RE = /insert\s+into\s+data_rows\b/i
/** A `table_id = ${bind}` or `table_id in (` enumeration predicate. */
const TABLE_ID_ENUM_RE = /\btable_id\s*(?:=\s*\$\{|in\s*\()/i
/** The `set table_id = ${…}` assignment in an UPDATE (not an enumeration). */
const SET_TABLE_ID_RE = /\bset\s+table_id\s*=\s*\$\{[^}]*\}/gi

/** Does this literal touch `data_rows` in a way that MUST carry `site_id`? */
function requiresSiteId(literal: string): boolean {
  if (!DATA_ROWS_RE.test(literal)) return false
  if (INSERT_RE.test(literal)) return true
  // Drop `set table_id = …` assignments before looking for an enumeration
  // predicate, so an UPDATE-by-id that reassigns the table isn't misread.
  const withoutSetClause = literal.replace(SET_TABLE_ID_RE, '')
  return TABLE_ID_ENUM_RE.test(withoutSetClause)
}

function hasSiteId(literal: string): boolean {
  return /\bsite_id\b/.test(literal)
}

function isAllowlisted(relFile: string, literal: string): boolean {
  return PENDING_QUERY_ALLOWLIST.some(
    (entry) => entry.file === relFile && literal.includes(entry.needle),
  )
}

interface Violation {
  file: string
  literal: string
}

interface ScanResult {
  violations: Violation[]
  /** Count of enforced literals that correctly carry `site_id` (sanity check). */
  compliant: number
}

function scanRepositories(): ScanResult {
  const violations: Violation[] = []
  let compliant = 0
  for (const file of walk(REPO_ROOT)) {
    const relFile = relative(PROJECT_ROOT, file)
    const src = readFileSync(file, 'utf8')
    for (const literal of extractTemplateLiterals(src)) {
      if (!requiresSiteId(literal)) continue
      if (hasSiteId(literal)) {
        compliant++
        continue
      }
      if (isAllowlisted(relFile, literal)) continue
      violations.push({ file: relFile, literal: literal.trim() })
    }
  }
  return { violations, compliant }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('site_id tenant isolation — server/repositories', () => {
  test('the tenant-scoped table registry matches the migration schema', () => {
    const fromMigration = tenantScopedTablesFromMigration()
    expect(fromMigration.size).toBeGreaterThan(0)
    expect(fromMigration.has('data_rows')).toBe(true)

    const classified = new Set<string>([...ISOLATION_ENFORCED, ...ISOLATION_PENDING])

    const unclassified = [...fromMigration].filter((t) => !classified.has(t))
    const phantom = [...classified].filter((t) => !fromMigration.has(t))

    if (unclassified.length > 0 || phantom.length > 0) {
      throw new Error(
        `[site-id-tenant-isolation] the tenant-scoped table registry has drifted from the ` +
          `migration schema.\n` +
          (unclassified.length
            ? `  Tables gaining site_id in the migration but not classified here ` +
              `(add to ISOLATION_ENFORCED or ISOLATION_PENDING):\n    ${unclassified.join('\n    ')}\n`
            : '') +
          (phantom.length
            ? `  Tables classified here but no longer add site_id in the migration ` +
              `(remove them):\n    ${phantom.join('\n    ')}\n`
            : ''),
      )
    }
    expect(classified).toEqual(fromMigration)
  })

  test('ISOLATION_ENFORCED and ISOLATION_PENDING are disjoint', () => {
    const overlap = [...ISOLATION_ENFORCED].filter((t) => ISOLATION_PENDING.has(t))
    expect(overlap).toEqual([])
  })

  test('the scanner actually inspected enforced data_rows queries', () => {
    // Guard against the extractor silently returning nothing (a regex/layout
    // change that makes the gate a no-op). The content-row layer has several
    // compliant enforced literals (scoped reads + inserts).
    const { compliant } = scanRepositories()
    expect(compliant).toBeGreaterThanOrEqual(5)
  })

  test('every enforced data_rows query is site-scoped (or explicitly pending)', () => {
    const { violations } = scanRepositories()
    if (violations.length === 0) {
      expect(violations).toHaveLength(0)
      return
    }
    const lines = violations.map(
      (v) => `  ${v.file}\n    ${v.literal.replace(/\s+/g, ' ').slice(0, 160)}`,
    )
    throw new Error(
      `[site-id-tenant-isolation] ${violations.length} data_rows query(ies) touch the tenant ` +
        `table without a site_id key. This leaks one tenant's content into another's editor.\n` +
        `Add a \`site_id = \${siteId}\` predicate (reads/updates) or the site_id column (inserts). ` +
        `If the query is deliberately cross-site for now, add it to PENDING_QUERY_ALLOWLIST with a ` +
        `reason.\n\nOffending queries:\n${lines.join('\n')}`,
    )
  })

  test('no PENDING_QUERY_ALLOWLIST entry is stale', () => {
    const stale: string[] = []
    for (const entry of PENDING_QUERY_ALLOWLIST) {
      const abs = join(PROJECT_ROOT, entry.file)
      if (!existsSync(abs)) {
        stale.push(`${entry.file} — file no longer exists`)
        continue
      }
      const literals = extractTemplateLiterals(readFileSync(abs, 'utf8'))
      const match = literals.find((l) => l.includes(entry.needle))
      if (!match) {
        stale.push(`${entry.file} — no literal contains the needle ${JSON.stringify(entry.needle)}`)
      } else if (hasSiteId(match) || !requiresSiteId(match)) {
        stale.push(
          `${entry.file} — the query is now site-scoped (or no longer enumerates); remove the entry`,
        )
      }
    }
    if (stale.length > 0) {
      throw new Error(
        `[site-id-tenant-isolation] PENDING_QUERY_ALLOWLIST has ${stale.length} stale entry(ies). ` +
          `The allowlist may only shrink as isolation lands — remove each fixed/removed query:\n  ` +
          stale.join('\n  '),
      )
    }
    expect(stale).toEqual([])
  })
})

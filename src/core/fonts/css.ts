/**
 * Generate font CSS for the site's installed font library.
 *
 * Two delivery paths, one per font source:
 *   - `source: 'custom'` (media-library uploads) emit self-hosted `@font-face`
 *     rules via `generateSiteFontsCss` — `src` URLs reference files under
 *     `/uploads/media/...`, gated by `isSafeFontSrc`.
 *   - `source: 'google'` fonts are NOT self-hosted. `buildGoogleFontsLinkTags`
 *     (publisher head) and `buildGoogleFontsHref` (canvas / admin-shell DOM
 *     injection) load them straight from the Google Fonts CSS2 CDN
 *     (`fonts.googleapis.com`). Google entries carry no on-disk files, so the
 *     `@font-face` generator naturally skips them.
 *
 * Loading Google fonts from the CDN (rather than downloading woff2 files to
 * `/uploads/fonts/`) keeps published sites self-contained for edge / object-
 * storage hosting — there are no font binaries to push into the asset bucket.
 *
 * The `@font-face` string is consumed by both the canvas runtime (injected into
 * `<style id="mc-fonts">`) and the publisher (emitted into the head `<style>`
 * block), so the editor preview matches the published page exactly.
 */

import type { FontEntry, FontFile, FontFileFormat, SiteFontsSettings } from './schemas'
import { isSafeFontSrc } from './schemas'
import { parseVariant, variantsToCss2Axis } from './variants'
import {
  fontTokenCssVariable,
  resolveFontTokenStack,
  sortFontTokens,
} from './tokens'

/**
 * CSS `format(...)` token for each container format. The CSS keyword differs
 * from the file extension for the legacy outline formats (`ttf` →
 * `"truetype"`, `otf` → `"opentype"`), so this mapping is the single source of
 * truth for the emitted token.
 */
const CSS_FORMAT_TOKEN: Record<FontFileFormat, string> = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'truetype',
  otf: 'opentype',
}

/**
 * Strip characters that could break out of a CSS string literal OR a parent
 * `<style>` block. The font `family` value is user-controlled (selected from a
 * curated directory but stored in JSON) so we treat it as untrusted at the
 * CSS boundary. `<` / `>` are stripped to prevent `</style>` from terminating
 * the surrounding `<style>` block (CWE-79 / Constraint #228).
 */
function escapeCssString(value: string): string {
  return value.replace(/["\\\n\r<>]/g, '')
}

/**
 * URLs to woff2 files we wrote to disk. Path tokens are restricted to the
 * `/uploads/fonts/` namespace and pass through `validateFontEntry` first, so
 * they are safe inside `url("...")`. We still strip newlines, quotes, and
 * angle brackets defensively.
 */
function escapeCssUrl(value: string): string {
  return value.replace(/["\\\n\r<>]/g, '')
}

/**
 * Whitelist what's allowed inside a `unicode-range:` declaration. The CSS spec
 * accepts `U+`, hex, dashes, commas, and whitespace — anything outside that
 * set (especially `<`, `>`, `;`, `{`, `}`, or quotes) could break out of the
 * `@font-face` block or the surrounding `<style>` tag. Mirrors
 * `isSafeUnicodeRange` in `core/fonts/schemas`; we re-apply it at the CSS
 * boundary so corrupted persisted data can't leak into the published HTML.
 */
const SAFE_UNICODE_RANGE_RE = /^[\sUu+0-9A-Fa-f,-]+$/

function escapeCssUnicodeRange(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 2048) return null
  if (!SAFE_UNICODE_RANGE_RE.test(trimmed)) return null
  return trimmed
}

/**
 * Build a single `@font-face` rule for one slice (variant + optional
 * unicode-range). Returns `null` for unparseable variants — callers should
 * skip them.
 *
 * When `unicodeRange` is provided, the rule pins the slice to that range so
 * the browser's font loader fetches it only when text in that range is used.
 * This matches Google's CSS2 sharding 1:1; without the range, the file would
 * cover all characters and the browser would download every slice for every
 * page (defeating the point of the slicing).
 */
function fontFaceRule(
  family: string,
  variant: string,
  urlPath: string,
  format: FontFileFormat,
  unicodeRange?: string,
): string | null {
  const parsed = parseVariant(variant)
  if (!parsed) return null
  const lines = [
    `@font-face {`,
    `  font-family: "${escapeCssString(family)}";`,
    `  font-style: ${parsed.italic ? 'italic' : 'normal'};`,
    `  font-weight: ${parsed.weight};`,
    `  font-display: swap;`,
    `  src: url("${escapeCssUrl(urlPath)}") format("${CSS_FORMAT_TOKEN[format]}");`,
  ]
  if (unicodeRange) {
    const safe = escapeCssUnicodeRange(unicodeRange)
    if (safe) lines.push(`  unicode-range: ${safe};`)
  }
  lines.push(`}`)
  return lines.join('\n')
}

/**
 * Generate the full @font-face block for every installed entry.
 * Empty input yields the empty string — caller should skip the `<style>` tag
 * entirely if there are no fonts installed.
 */
export function generateSiteFontsCss(
  fonts: SiteFontsSettings | null | undefined,
): string {
  if (!fonts || !fonts.items || fonts.items.length === 0) return ''

  const blocks: string[] = []
  for (const entry of fonts.items) {
    if (!entry || !entry.family || !entry.files) continue
    for (const file of entry.files) {
      if (!file) continue
      // Re-apply the storage-boundary path check at the CSS boundary so a
      // corrupted site document can't leak an untrusted URL into published
      // HTML. Self-hosted /uploads/ paths and media-backed entries pass;
      // arbitrary third-party URLs are skipped (no-CDN guarantee).
      if (!isSafeFontSrc(file.path, file.mediaAssetId)) continue
      const rule = fontFaceRule(entry.family, file.variant, file.path, file.format, file.unicodeRange)
      if (rule) blocks.push(rule)
    }
  }
  return blocks.join('\n\n')
}

/**
 * Slugify a family name for use as a CSS custom-property suffix:
 * "Noto Sans JP" → "noto-sans-jp".
 *
 * Also used to derive the on-disk directory name under `/uploads/fonts/`,
 * keeping settings, files, and CSS variables aligned.
 */
export function familySlug(family: string): string {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Generate the `:root { --font-primary: "Family", fallback; }` block from the
 * site's editable font tokens. Installed families do not emit direct variables;
 * authored styles should bind to tokens so family swaps preserve declarations.
 */
export function generateFontTokenVariablesCss(
  fonts: SiteFontsSettings | null | undefined,
): string {
  if (!fonts?.tokens || fonts.tokens.length === 0) return ''
  const declarations: string[] = []
  for (const token of sortFontTokens(fonts.tokens)) {
    const variable = fontTokenCssVariable(token.variable)
    if (!variable) continue
    declarations.push(`  ${variable}: ${resolveFontTokenStack(token, fonts)};`)
  }
  if (declarations.length === 0) return ''
  return `:root {\n${declarations.join('\n')}\n}`
}

/**
 * Combine `@font-face` rules and `--font-*` tokens. This is the single block
 * that gets injected into the canvas and pasted into the publisher head.
 */
export function generateFontsCss(fonts: SiteFontsSettings | null | undefined): string {
  const tokens = generateFontTokenVariablesCss(fonts)
  const faces = generateSiteFontsCss(fonts)
  return [tokens, faces].filter(Boolean).join('\n\n')
}

/**
 * Lightweight summary used by tests and diagnostics — counts how many faces
 * the generator would emit.
 */
export function fontFaceCount(entry: FontEntry): number {
  if (!entry?.files) return 0
  return entry.files.filter((f): f is FontFile => f != null).length
}

// ---------------------------------------------------------------------------
// Google Fonts CSS2 CDN linkage
// ---------------------------------------------------------------------------

const GOOGLE_FONTS_CSS2_BASE = 'https://fonts.googleapis.com/css2'

/**
 * Escape a value for safe interpolation inside a double-quoted HTML attribute.
 * The href is assembled from `encodeURIComponent(family)` (already URL-safe) +
 * the fixed axis grammar, so this mainly turns the `&` separators into `&amp;`
 * for a valid attribute, and defends against any stray `<`/`>`/`"`.
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Build the Google Fonts CSS2 stylesheet URL for every `source: 'google'` entry
 * in the library, or `null` when the site has no Google fonts.
 *
 * Each family becomes a `family=<Family>:<axis>` parameter — the family name is
 * URL-encoded, and the axis tuple comes from `variantsToCss2Axis` (a strict
 * digits/`;`/`,` grammar), so the value is safe to interpolate. `display=swap`
 * matches the `font-display: swap` we emit for self-hosted faces.
 *
 * Returned raw (unescaped) — suitable for assigning to a DOM `link.href`.
 * `buildGoogleFontsLinkTags` escapes it for HTML markup.
 */
export function buildGoogleFontsHref(
  fonts: SiteFontsSettings | null | undefined,
): string | null {
  if (!fonts?.items?.length) return null
  const families: string[] = []
  for (const entry of fonts.items) {
    if (!entry || entry.source !== 'google' || !entry.family) continue
    const encodedFamily = encodeURIComponent(entry.family)
    const axis = variantsToCss2Axis(entry.variants ?? [])
    families.push(axis ? `${encodedFamily}:${axis}` : encodedFamily)
  }
  if (families.length === 0) return null
  const familyParams = families.map((family) => `family=${family}`).join('&')
  return `${GOOGLE_FONTS_CSS2_BASE}?${familyParams}&display=swap`
}

/**
 * Build the `<head>` `<link>` markup that loads the site's Google fonts from the
 * CSS2 CDN: two `preconnect` hints + the stylesheet link. Returns the empty
 * string when there are no Google fonts (the publisher then omits the lines
 * entirely). Custom (self-hosted) fonts are unaffected — they stay in
 * `@font-face` rules via `generateSiteFontsCss`.
 */
export function buildGoogleFontsLinkTags(
  fonts: SiteFontsSettings | null | undefined,
): string {
  const href = buildGoogleFontsHref(fonts)
  if (!href) return ''
  return [
    '  <link rel="preconnect" href="https://fonts.googleapis.com">',
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    `  <link rel="stylesheet" href="${escapeHtmlAttribute(href)}">`,
  ].join('\n')
}

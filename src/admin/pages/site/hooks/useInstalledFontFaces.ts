/**
 * useInstalledFontFaces — make the site's installed fonts render in the admin
 * document head so panels can preview text in the site's real fonts.
 *
 * Two paths, matching the canvas + publisher:
 *   - Custom fonts inject their self-hosted `@font-face` rules (a `<style>`);
 *     the `/uploads/media/...` `src` URLs resolve through the dev proxy /
 *     published server exactly as on the canvas.
 *   - Google fonts inject a CSS2 CDN `<link>` (they are not self-hosted).
 *
 * Without this, any `fontFamily` referencing an installed family would fall
 * back to system-ui inside the admin shell (where panels live, outside the
 * canvas iframe).
 *
 * Shared by the Typography panel's FontsSection and the Framework panel's
 * FrameworkHome — `dataSource` tags each caller's injected element so the
 * injections stay distinguishable in the inspector.
 */
import { useEffect } from 'react'
import type { FontEntry } from '@core/fonts'
import { buildGoogleFontsHref, generateSiteFontsCss } from '@core/fonts'

export function useInstalledFontFaces(fonts: readonly FontEntry[], dataSource: string): void {
  const settings = { items: [...fonts] }
  const css = generateSiteFontsCss(settings)
  const googleFontsHref = buildGoogleFontsHref(settings)

  useEffect(() => {
    if (!css) return
    const styleEl = document.createElement('style')
    styleEl.setAttribute('data-source', dataSource)
    styleEl.textContent = css
    document.head.appendChild(styleEl)
    return () => {
      styleEl.remove()
    }
  }, [css, dataSource])

  useEffect(() => {
    if (!googleFontsHref) return
    const linkEl = document.createElement('link')
    linkEl.rel = 'stylesheet'
    linkEl.href = googleFontsHref
    linkEl.setAttribute('data-source', `${dataSource}:google-fonts`)
    document.head.appendChild(linkEl)
    return () => {
      linkEl.remove()
    }
  }, [googleFontsHref, dataSource])
}

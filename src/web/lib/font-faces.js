// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
// Shared @font-face construction for the /fonts page.
//
// Both the server-side `/api/fonts/faces.css` route and the client-side
// `fonts-page.js` controller derive their CSS family names from the same
// `fontFaceName()` so the stylesheet the route emits and the names the
// controller assigns to preview lines can never drift apart.
//
// This module is browser-safe (no Node imports) — `fonts-page.js` is
// bundled through Bun.build with `target: 'browser'`, which inlines this
// import into the page bundle.

/**
 * CSS `font-family` name for a single extracted font file. Deterministic
 * from the family + file id so the route and the page agree without
 * passing a lookup map across the server/client boundary.
 *
 * @param {string} familyId
 * @param {string} fileId
 * @returns {string}
 */
export function fontFaceName(familyId, fileId) {
  return `apple-docs-${familyId}-${fileId}`
}

/**
 * Map a stored font file `format` to the CSS `format(...)` hint. Empty
 * string when the format is unknown — the caller omits the `format()`
 * clause entirely in that case.
 *
 * @param {string} format
 * @returns {string}
 */
export function formatHint(format) {
  switch ((format || '').toLowerCase()) {
    case 'ttf':
      return 'truetype'
    case 'otf':
      return 'opentype'
    case 'ttc':
      return 'collection'
    default:
      return ''
  }
}

/**
 * Default font-file URL builder: the same-origin `/api/fonts/file/<id>`
 * download route. Parameterized so the static build can swap in a
 * different base while the route + page keep the dev default.
 *
 * @param {string} fileId
 * @returns {string}
 */
function defaultFileUrl(fileId) {
  return `/api/fonts/file/${encodeURIComponent(fileId)}`
}

/**
 * Build the `@font-face` rule set for every family file as a `text/css`
 * string. `font-display: swap` keeps preview text visible while the file
 * downloads.
 *
 * @param {Array<{ id: string, files?: Array<{ id: string, format?: string }> }>} families
 * @param {{ fileUrl?: (fileId: string) => string }} [opts]
 * @returns {string}
 */
export function buildFontFaceCss(families, { fileUrl = defaultFileUrl } = {}) {
  const rules = []
  for (const family of families ?? []) {
    for (const file of family.files ?? []) {
      const name = fontFaceName(family.id, file.id)
      const url = fileUrl(file.id)
      const format = formatHint(file.format)
      rules.push(`@font-face { font-family: "${name}"; src: url("${url}")${format ? ` format("${format}")` : ''}; font-display: swap; }`)
    }
  }
  return rules.join('\n')
}

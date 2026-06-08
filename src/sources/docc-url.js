/**
 * Detect external DocC-built documentation sites from a URL alone.
 *
 * Apple's `technologies.json` (and inline references) point at a handful of
 * documentation sets hosted OUTSIDE developer.apple.com — CareKit
 * (GitHub Pages), the Private Cloud Compute Security Guide (security.apple.com),
 * and Swift's DocC manual (swift.org). They are all DocC archives: the rendered
 * page lives at `{base}/documentation/<path>` and the backing JSON at
 * `{base}/data/documentation/<path>.json`, exactly like developer.apple.com but
 * under a different origin (and, for project sites, a path prefix like
 * `/CareKit`).
 *
 * `parseDoccArchiveUrl` recognises that shape structurally — no network — so a
 * non-DocC external link (e.g. github.com/ResearchKit, the MusicKit JS landing
 * page) is rejected before any probe. A caller still confirms a candidate is a
 * real DocC archive by fetching the derived data URL (see ExternalDoccAdapter).
 */

const DOC_SEGMENT = '/documentation/'

// Mirror the operator/punctuation guardrails in apple/normalizer.js so a doc
// path segment that is clearly a Swift operator (not a page) is rejected.
const OPERATOR_SEGMENT = /^\.[.\-+*/<>=!&|^~%_]/

/**
 * @param {string} rawUrl
 * @returns {{ slug: string, baseUrl: string, entryKey: string } | null}
 *   `baseUrl` keeps its original case (GitHub Pages paths are case-sensitive);
 *   `entryKey`/`slug` are the lowercased canonical doc path + its first segment,
 *   matching the key form produced by apple/normalizer.js so references resolve.
 */
export function parseDoccArchiveUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null

  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  // DocC archives are always served over HTTPS; reject anything else outright
  // (no http://, no file://, no internal schemes — keeps the probe surface
  // to public web origins only).
  if (url.protocol !== 'https:') return null

  // developer.apple.com is the primary corpus, owned by the apple-docc adapter.
  // Never re-handle it as an "external" archive.
  if (url.hostname === 'developer.apple.com' || url.hostname.endsWith('.developer.apple.com')) {
    return null
  }

  const idx = url.pathname.indexOf(DOC_SEGMENT)
  if (idx === -1) return null

  // Everything before `/documentation/` is the archive's path prefix (empty for
  // root-hosted archives like security.apple.com, `/CareKit` for the GitHub
  // Pages project site). Case is preserved — the live host is case-sensitive.
  const prefix = url.pathname.slice(0, idx)
  const rest = url.pathname.slice(idx + DOC_SEGMENT.length).replace(/\/+$/, '').toLowerCase()
  if (!rest) return null

  const segments = rest.split('/')
  for (const seg of segments) {
    if (seg === '') return null
    if (OPERATOR_SEGMENT.test(seg)) return null
  }

  return {
    slug: segments[0],
    baseUrl: `${url.protocol}//${url.host}${prefix}`,
    entryKey: rest,
  }
}

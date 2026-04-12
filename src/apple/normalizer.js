/**
 * Normalize any Apple documentation identifier to a canonical lowercase path.
 * Handles: doc://..., /documentation/..., documentation/..., mixed-case paths.
 * Returns null for identifiers that can't be valid documentation pages.
 */
export function normalizeIdentifier(raw) {
  if (!raw || typeof raw !== 'string') return null

  let id = raw

  // Reject full URLs that aren't Apple doc identifiers (e.g. https://...)
  if (/^https?:\/\//.test(id)) return null

  // Strip doc:// URI scheme
  // documentation: doc://com.apple.SwiftUI/documentation/SwiftUI/View
  // design: doc://com.apple.design/design/human-interface-guidelines/...
  const docMatch = id.match(/^doc:\/\/[^/]+\/documentation\/(.+)$/)
  if (docMatch) id = docMatch[1]
  const designDocMatch = id.match(/^doc:\/\/[^/]+\/(design\/.+)$/)
  if (designDocMatch) id = designDocMatch[1]

  // Strip leading /documentation/ but preserve /design/ as a namespace prefix
  if (id.startsWith('/design/')) id = id.slice(1) // keep 'design/...'
  else if (id.startsWith('/documentation/')) id = id.slice('/documentation/'.length)

  // Strip leading documentation/ (no slash)
  if (id.startsWith('documentation/')) id = id.slice('documentation/'.length)

  // Lowercase for canonical form
  id = id.toLowerCase()

  // Remove trailing slashes
  id = id.replace(/\/+$/, '')

  // Strip fragment identifiers (e.g. "page#section")
  const hashIdx = id.indexOf('#')
  if (hashIdx !== -1) id = id.slice(0, hashIdx)

  if (!id) return null

  // Reject paths with segments that are clearly not standalone pages:
  // - dot-prefixed operator segments (.==, .!=, ._, ..<, ...)
  // - segments that are just punctuation
  const segments = id.split('/')
  for (const seg of segments) {
    // Segment starts with a dot followed by operator chars — Swift operator, not a page
    if (/^\.[\.\-\+\*\/\<\>\=\!\&\|\^\~\%_]/.test(seg)) return null
    // Empty segment (double slash)
    if (seg === '') return null
  }

  return id
}

/**
 * Extract the root slug (first path segment) from a canonical path.
 */
export function extractRootSlug(canonicalPath) {
  if (!canonicalPath) return null
  const slash = canonicalPath.indexOf('/')
  return slash === -1 ? canonicalPath : canonicalPath.slice(0, slash)
}

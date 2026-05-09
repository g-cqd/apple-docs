/**
 * Section metadata extractors — title, number, abstract, last-updated.
 * Operate on already-converted Markdown (or the source HTML for last-
 * updated, which lives in a structural element).
 * Extracted from guidelines-parser.js as part of P4.5.
 */

export function resolveTitle(meta, markdown) {
  // data-sidenav attribute value is the cleanest title source for <li> elements
  if (meta.sidenavTitle) {
    return meta.sidenavTitle.trim()
  }

  // For <h3> elements without a data-sidenav value, extract from markdown
  // The first line of markdown is typically "### N. Title"
  const firstLine = markdown.split('\n').find(l => l.trim())
  if (firstLine) {
    // Strip markdown heading prefix and numbering-dot prefix
    const title = firstLine.replace(/^#+\s*/, '').trim()
    return title
  }

  // Fallback to id
  return meta.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Extract a section number like "1.1" or "3.1.3(a)" from a title.
 */
export function extractSectionNumber(title) {
  const m = title.match(/^(\d+(?:\.\d+)*(?:\([a-z]\))?)[\s.]/)
  if (m) return m[1]
  // Try matching the whole title as a section number (e.g., for "5. Legal")
  const m2 = title.match(/^(\d+)\.?\s/)
  if (m2) return m2[1]
  return null
}

/**
 * Extract the first sentence as an abstract.
 */
export function extractAbstract(markdown, _title) {
  // Remove the title line, heading lines, and list prefixes
  const lines = markdown.split('\n')
    .filter(l => !l.startsWith('#') && l.trim())
    .map(l => l.replace(/^[-*]\s+/, '').trim())
  const text = lines.join(' ')
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  // First sentence
  const m = text.match(/^(.+?[.!?])\s/)
  if (m) return m[1].slice(0, 300)
  return text.slice(0, 300)
}

/**
 * Extract the "Last Updated" date from the page.
 */
export function extractLastUpdated(html) {
  const m = html.match(/Last Updated:\s*<a[^>]*>([^<]+)<\/a>/)
  return m ? m[1].trim() : null
}

/**
 * Build parent→child relationships from section numbers.
 * E.g., section "1" is parent of "1.1", which is parent of "1.1.1".
 */

/**
 * HTML content extraction utilities for converting HTML documentation pages
 * into the normalized document model.
 *
 * Used by Swift.org and Apple Archive adapters.
 * No external HTML parser dependency — uses regex/string-based parsing.
 */

import { createDocumentTemplate } from './document-template.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Block-level HTML tags that should produce paragraph breaks. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'tr', 'blockquote', 'pre', 'section', 'article',
  'header', 'footer', 'nav', 'aside', 'main', 'figure',
  'figcaption', 'details', 'summary', 'ul', 'ol', 'dl',
  'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot',
])

/** Elements to strip entirely (including their content). */
const STRIP_ELEMENTS = ['nav', 'header', 'footer', 'script', 'style', 'noscript']
const stripNestedElementRegexCache = new Map()
const stripSingleElementRegexCache = new Map()
const selectorIdRegexCache = new Map()
const selectorClassRegexCache = new Map()
const openTagRegexCache = new Map()
const SECTION_SPLIT_REGEX_BY_TAG = {
  h2: /(<h2[\s>][\s\S]*?<\/h2>)/gi,
  h3: /(<h3[\s>][\s\S]*?<\/h3>)/gi,
}

function getStripNestedElementRegex(tag) {
  if (!stripNestedElementRegexCache.has(tag)) {
    stripNestedElementRegexCache.set(tag, new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi'))
  }
  return stripNestedElementRegexCache.get(tag)
}

function getStripSingleElementRegex(tag) {
  if (!stripSingleElementRegexCache.has(tag)) {
    stripSingleElementRegexCache.set(tag, new RegExp(`<${tag}(\\s[^>]*)?\\s*/?>`, 'gi'))
  }
  return stripSingleElementRegexCache.get(tag)
}

function getSelectorIdRegex(id) {
  if (!selectorIdRegexCache.has(id)) {
    selectorIdRegexCache.set(id, new RegExp(`\\bid\\s*=\\s*["']${escapeRegex(id)}["']`))
  }
  return selectorIdRegexCache.get(id)
}

function getSelectorClassRegex(className) {
  if (!selectorClassRegexCache.has(className)) {
    selectorClassRegexCache.set(className, new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${escapeRegex(className)}\\b[^"']*["']`))
  }
  return selectorClassRegexCache.get(className)
}

function getOpenTagRegex(tagPattern) {
  if (!openTagRegexCache.has(tagPattern)) {
    openTagRegexCache.set(tagPattern, new RegExp(`<(${tagPattern})(\\s[^>]*)?>`, 'gi'))
  }
  return openTagRegexCache.get(tagPattern)
}

// ---------------------------------------------------------------------------
// Entity decoding
// ---------------------------------------------------------------------------

/**
 * Decode common HTML entities and numeric character references.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text
    // Named entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    // Decimal numeric entities: &#NNN;
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    // Hex numeric entities: &#xHH; or &#XHH;
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
}

// ---------------------------------------------------------------------------
// htmlToPlainText
// ---------------------------------------------------------------------------

/**
 * Convert an HTML string to plain text.
 *
 * - Strips all HTML tags.
 * - Decodes common HTML entities.
 * - Preserves paragraph breaks for block-level elements.
 * - Collapses multiple whitespace within paragraphs to a single space.
 * - Trims the result.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToPlainText(html) {
  if (!html) return ''

  // Strip XML declarations and processing instructions
  let cleaned = html.replace(/<\?[^?]*\?>/g, '')
  // Strip SVG elements entirely
  cleaned = cleaned.replace(/<svg[\s\S]*?<\/svg>/gi, '')

  // Replace opening block tags with a paragraph-break sentinel
  const withBreaks = cleaned.replace(
    /<(\/?)(\w+)([^>]*)>/g,
    (_match, _slash, tag) => {
      const lower = tag.toLowerCase()
      if (BLOCK_TAGS.has(lower)) {
        return '\n\n'
      }
      return ' '
    },
  )

  const decoded = decodeEntities(withBreaks)

  // Normalise: collapse runs of spaces/tabs within each paragraph; then
  // collapse 3+ newlines to exactly 2 (one blank line).
  const lines = decoded
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())

  const joined = lines.join('\n').replace(/\n{3,}/g, '\n\n')

  return joined.trim()
}

// ---------------------------------------------------------------------------
// extractMetaInfo
// ---------------------------------------------------------------------------

/**
 * Extract document-level meta information from an HTML string.
 *
 * @param {string} html
 * @returns {{ title: string|null, description: string|null, ogTitle: string|null }}
 */
export function extractMetaInfo(html) {
  if (!html) return { title: null, description: null, ogTitle: null }

  // <title>...</title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const rawTitle = titleMatch ? titleMatch[1] : null
  const title = rawTitle ? htmlToPlainText(rawTitle).trim() || null : null

  // <meta name="description" content="...">
  const descMatch = html.match(
    /<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']*)["'][^>]*>/i,
  ) ?? html.match(
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+name\s*=\s*["']description["'][^>]*>/i,
  )
  const description = descMatch ? decodeEntities(descMatch[1]).trim() || null : null

  // <meta property="og:title" content="...">
  const ogMatch = html.match(
    /<meta[^>]+property\s*=\s*["']og:title["'][^>]+content\s*=\s*["']([^"']*)["'][^>]*>/i,
  ) ?? html.match(
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+property\s*=\s*["']og:title["'][^>]*>/i,
  )
  const ogTitle = ogMatch ? decodeEntities(ogMatch[1]).trim() || null : null

  return { title, description, ogTitle }
}

// ---------------------------------------------------------------------------
// Internal HTML helpers
// ---------------------------------------------------------------------------

/**
 * Strip elements and their content from an HTML string.
 * Handles nested elements of the same tag.
 *
 * @param {string} html
 * @param {string[]} tags - Lowercase tag names to strip.
 * @returns {string}
 */
function stripElements(html, tags) {
  let result = html
  for (const tag of tags) {
    const nestedPattern = getStripNestedElementRegex(tag)
    const singlePattern = getStripSingleElementRegex(tag)

    // Iteratively strip to handle nesting
    let prev
    do {
      prev = result
      nestedPattern.lastIndex = 0
      result = result.replace(nestedPattern, '')
    } while (result !== prev)

    // Also strip self-closing or unclosed tags
    singlePattern.lastIndex = 0
    result = result.replace(singlePattern, '')
  }
  return result
}

/**
 * Extract the inner HTML of the first element matching a simple selector.
 * Supports: tag, .className, #id, and simple combinations like "tag.class".
 *
 * @param {string} html
 * @param {string} selector
 * @returns {string|null}
 */
function extractBySelector(html, selector) {
  // Determine tag and optional class/id constraint
  const idMatch = selector.match(/^(\w*)?#([\w-]+)/)
  const classMatch = selector.match(/^(\w*)?\.([\w-]+)/)

  let tagPattern
  let attrFilter = null

  if (idMatch) {
    const tag = idMatch[1] || '\\w+'
    const id = idMatch[2]
    tagPattern = tag
    attrFilter = getSelectorIdRegex(id)
  } else if (classMatch) {
    const tag = classMatch[1] || '\\w+'
    const cls = classMatch[2]
    tagPattern = tag
    attrFilter = getSelectorClassRegex(cls)
  } else {
    tagPattern = escapeRegex(selector)
  }

  // Find the first opening tag that matches
  const openTagRe = getOpenTagRegex(tagPattern)
  openTagRe.lastIndex = 0
  let match
  while ((match = openTagRe.exec(html)) !== null) {
    if (attrFilter && !attrFilter.test(match[0])) continue

    const actualTag = match[1]

    // Extract balanced inner HTML
    const inner = extractBalancedInner(html, actualTag, match.index)
    if (inner !== null) return inner
  }
  return null
}

/**
 * Extract the inner HTML of the element starting at `startPos` for `tag`.
 *
 * @param {string} html
 * @param {string} tag - Lowercase tag name.
 * @param {number} startPos - Position of the opening '<' of the element.
 * @returns {string|null}
 */
function extractBalancedInner(html, tag, startPos) {
  const lowerHtml = html.toLowerCase()
  const lowerTag = tag.toLowerCase()

  // Find end of opening tag
  const openEnd = html.indexOf('>', startPos)
  if (openEnd === -1) return null
  const contentStart = openEnd + 1

  let depth = 1
  let pos = contentStart

  while (depth > 0 && pos < html.length) {
    const openIdx = lowerHtml.indexOf(`<${lowerTag}`, pos)
    const closeIdx = lowerHtml.indexOf(`</${lowerTag}`, pos)

    if (closeIdx === -1) break

    if (openIdx !== -1 && openIdx < closeIdx) {
      depth++
      pos = openIdx + 1
    } else {
      depth--
      if (depth === 0) {
        return html.slice(contentStart, closeIdx)
      }
      pos = closeIdx + 1
    }
  }

  return null
}

/**
 * Escape a string for use in a RegExp.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// extractHtmlContent
// ---------------------------------------------------------------------------

/**
 * Extract structured content from an HTML documentation page.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {string} [opts.containerSelector] - CSS-like selector for main content.
 * @returns {{ title: string|null, description: string|null, sections: Array<{ heading: string|null, content: string }> }}
 */
export function extractHtmlContent(html, opts = {}) {
  if (!html) return { title: null, description: null, sections: [] }

  const meta = extractMetaInfo(html)

  // ── Locate content container ───────────────────────────────────────────────

  let container = null

  if (opts.containerSelector) {
    container = extractBySelector(html, opts.containerSelector)
  }

  if (!container) {
    // Try default containers in order
    for (const sel of ['main', 'article', '.content', '#content', '#contents']) {
      const found = extractBySelector(html, sel)
      if (found) {
        container = found
        break
      }
    }
  }

  if (!container) {
    // Fall back to <body>
    container = extractBySelector(html, 'body') ?? html
  }

  // ── Strip navigation/chrome elements ──────────────────────────────────────

  const clean = stripElements(container, STRIP_ELEMENTS)

  // ── Resolve title ─────────────────────────────────────────────────────────

  const h1Match = clean.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  const h1Text = h1Match ? htmlToPlainText(h1Match[1]).trim() : null
  const title = meta.title || h1Text || null

  // ── Split by h2 (fallback: h3) ────────────────────────────────────────────

  const hasH2 = /<h2[\s>]/i.test(clean)
  const splitTag = hasH2 ? 'h2' : 'h3'
  const splitRe = SECTION_SPLIT_REGEX_BY_TAG[splitTag]
  splitRe.lastIndex = 0

  const parts = clean.split(splitRe)

  // parts[0] is content before first heading; subsequent pairs are [heading, content]
  const sections = []

  const leadContent = htmlToPlainText(parts[0]).trim()
  if (leadContent) {
    sections.push({ heading: null, content: leadContent })
  }

  // parts is: [lead, h2, content, h2, content, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const headingHtml = parts[i]
    const bodyHtml = parts[i + 1] ?? ''
    const heading = htmlToPlainText(headingHtml).trim() || null
    const content = htmlToPlainText(bodyHtml).trim()
    if (heading || content) {
      sections.push({ heading, content })
    }
  }

  // If no sections were produced, return a single section with all content
  if (sections.length === 0) {
    const allContent = htmlToPlainText(clean).trim()
    sections.push({ heading: null, content: allContent })
  }

  return { title, description: meta.description, sections }
}

// ---------------------------------------------------------------------------
// parseHtmlToNormalized
// ---------------------------------------------------------------------------

/**
 * Parse an HTML page into the canonical normalized document model.
 *
 * @param {string} html - Raw HTML string.
 * @param {string} key  - Canonical path key, e.g. 'swift/generics'.
 * @param {object} [opts]
 * @param {string} [opts.sourceType]
 * @param {string} [opts.kind]
 * @param {string} [opts.framework]
 * @param {string} [opts.url]
 * @param {string} [opts.language]
 * @param {string} [opts.containerSelector]
 * @param {object|null} [opts.sourceMetadata]
 * @returns {{ document: object, sections: object[], relationships: [] }}
 */
export function parseHtmlToNormalized(html, key, opts = {}) {
  const extracted = extractHtmlContent(html, { containerSelector: opts.containerSelector })

  const { title, description, sections: htmlSections } = extracted

  // abstractText: description if available, else first non-empty paragraph of
  // the lead section content
  let abstractText = description || null
  if (!abstractText && htmlSections.length > 0) {
    const leadContent = htmlSections[0].content
    if (leadContent) {
      // Take the first paragraph (text before first double-newline)
      abstractText = leadContent.split('\n\n')[0].trim() || null
    }
  }

  // headings: space-joined texts of all section headings for FTS
  const headingTexts = htmlSections
    .map(s => s.heading)
    .filter(Boolean)
  const headings = headingTexts.length > 0 ? headingTexts.join(' ') : null

  const document = createDocumentTemplate(key, title, abstractText, headings, {
    sourceType: opts.sourceType,
    kind: opts.kind,
    framework: opts.framework,
    url: opts.url,
    language: opts.language,
    sourceMetadata: opts.sourceMetadata,
  })

  // ── Sections ──────────────────────────────────────────────────────────────

  const sections = []
  let order = 0

  // Abstract section from description
  if (description) {
    sections.push({
      sectionKind: 'abstract',
      heading: null,
      contentText: description,
      contentJson: null,
      sortOrder: order++,
    })
  }

  // Discussion sections for each heading block
  for (const s of htmlSections) {
    // Skip the lead section if it's already captured as abstract
    if (s.heading === null && description && order === 1) continue
    if (!s.content && !s.heading) continue

    sections.push({
      sectionKind: s.heading === null ? 'abstract' : 'discussion',
      heading: s.heading ?? null,
      contentText: s.content || null,
      contentJson: null,
      sortOrder: order++,
    })
  }

  return { document, sections, relationships: [] }
}

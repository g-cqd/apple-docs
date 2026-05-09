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
const selectorIdRegexCache = new Map()
const selectorClassRegexCache = new Map()
const openTagRegexCache = new Map()
const SECTION_SPLIT_REGEX_BY_TAG = {
  h2: /(<h2[\s>][\s\S]*?<\/h2>)/gi,
  h3: /(<h3[\s>][\s\S]*?<\/h3>)/gi,
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
// htmlToMarkdown
// ---------------------------------------------------------------------------

/**
 * Convert an HTML fragment to a Markdown-flavored plain string while
 * preserving structural elements that `htmlToPlainText` would discard:
 * code blocks, inline code, links, lists, sub-headings, and emphasis.
 *
 * Designed for legacy archive HTML (apple-archive) that uses heterogeneous
 * patterns (e.g. multi-row `<div class="codesample"><table>` for code blocks,
 * `<dl class="termdef">` term lists, anchor-only `<a name="">` tags).
 *
 * The output is fed back through `markdownToHtml` at render time, so the
 * format only needs to be valid CommonMark + the few extensions our renderer
 * supports.
 *
 * @param {string} html
 * @returns {string} Markdown source
 */
/**
 * @param {string} html
 * @param {object} [opts]
 * @param {(href: string) => string|null} [opts.linkResolver] Rewrite each
 *   `<a href="…">` URL. Returns the new URL, the original if no rewrite is
 *   needed, or `null` to drop the link wrapper (keep the inner text).
 */
export function htmlToMarkdown(html, opts = {}) {
  if (!html) return ''

  const linkResolver = typeof opts.linkResolver === 'function' ? opts.linkResolver : null
  let s = html

  s = s.replace(/<\?[^?]*\?>/g, '')
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '')
  s = stripElements(s, STRIP_ELEMENTS)

  // Apple-archive code samples: <div class="codesample"><table>...<tr><td><pre>line</pre></td></tr>...
  // Concatenate every <pre> cell into a single fenced code block.
  s = s.replace(/<div[^>]+class=["'][^"']*codesample[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi, (_m, inner) => {
    const cellLines = []
    inner.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
      cellLines.push(decodeEntities(stripInlineTags(code)))
      return ''
    })
    if (cellLines.length === 0) return ''
    return `\n\n@@FENCE\n${cellLines.join('\n')}\n@@/FENCE\n\n`
  })

  // Strip legacy named anchors (no href, only `name`/`title`) — they were used
  // for cross-doc links in the old archive format and add only noise now.
  s = s.replace(/<a\s[^>]*\bname\s*=\s*["'][^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, '$1')

  // Standalone <pre> blocks → fenced code (after codesample handling above).
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const code = decodeEntities(stripInlineTags(inner))
    return `\n\n@@FENCE\n${code.replace(/^\n+|\n+$/g, '')}\n@@/FENCE\n\n`
  })

  // Inline <code>X</code>
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => {
    const text = decodeEntities(stripInlineTags(inner)).replace(/`/g, "'")
    return text ? `\`${text}\`` : ''
  })

  // <a href="X">Y</a> — markdown link.
  // The linkResolver gets first crack at every URL: it may rewrite (return a
  // new URL), keep (return the original or undefined), or unwrap (return null).
  s = s.replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => {
    const text = decodeEntities(stripInlineTags(txt)).trim()
    if (!text) return ''
    let resolved = href
    if (linkResolver) {
      const result = linkResolver(href)
      if (result === null) return text
      if (typeof result === 'string') resolved = result
    }
    return `[${text}](${resolved})`
  })

  // <strong>/<b>/<em>/<i>
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => {
    const text = decodeEntities(stripInlineTags(inner))
    return text ? `**${text}**` : ''
  })
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => {
    const text = decodeEntities(stripInlineTags(inner))
    return text ? `*${text}*` : ''
  })

  // Lists — process before <dl> so list items nested inside <dd> survive.
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, inner) => listToMarkdown(inner, false))
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner) => listToMarkdown(inner, true))

  // Definition lists (<dl><dt>term</dt><dd>def</dd>) — render as paragraphs
  // with bold terms. Apple archive uses these heavily for protocol descriptions
  // and additionally uses <h5> as the term inside <dl class="termdef">.
  // Run BEFORE the h3-h6 transform so the dl handler can see embedded headings.
  s = s.replace(/<dl[^>]*>([\s\S]*?)<\/dl>/gi, (_m, inner) => {
    const termRe = /<(dt|h[3-6])[^>]*>([\s\S]*?)<\/\1>/gi
    const ddRe = /<dd[^>]*>([\s\S]*?)<\/dd>/gi
    const terms = []
    const defs = []
    let m
    while ((m = termRe.exec(inner)) !== null) {
      const text = decodeEntities(stripInlineTags(m[2])).trim()
      if (text) terms.push(text)
    }
    while ((m = ddRe.exec(inner)) !== null) {
      const text = stripInlineTags(m[1]).trim()
      if (text) defs.push(text)
    }
    const out = []
    const len = Math.max(terms.length, defs.length)
    for (let i = 0; i < len; i++) {
      const t = terms[i]
      const d = defs[i]
      if (t && d) out.push(`**${t}** — ${decodeEntities(d)}`)
      else if (t) out.push(`**${t}**`)
      else if (d) out.push(decodeEntities(d))
    }
    return out.length ? `\n\n${out.join('\n\n')}\n\n` : ''
  })

  // Sub-headings inside the section body. h1 + h2 are extracted by the section
  // splitter upstream; render h3-h6 as nested markdown headings.
  for (let level = 3; level <= 6; level++) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi')
    const prefix = '#'.repeat(level)
    s = s.replace(re, (_m, inner) => {
      const text = decodeEntities(stripInlineTags(inner)).trim()
      return text ? `\n\n${prefix} ${text}\n\n` : ''
    })
  }

  // Convert remaining block tags to paragraph breaks; collapse all other tags to a space.
  s = s.replace(/<(\/?)(\w+)[^>]*>/g, (_match, _slash, tag) => {
    const lower = tag.toLowerCase()
    return BLOCK_TAGS.has(lower) ? '\n\n' : ' '
  })

  s = decodeEntities(s)

  // Stash fenced code content in opaque sentinels so whitespace normalization
  // below cannot collapse leading indentation inside code blocks.
  const fences = []
  s = s.replace(/@@FENCE\n([\s\S]*?)\n@@\/FENCE/g, (_m, code) => {
    fences.push(code)
    return `@@FENCE_SLOT_${fences.length - 1}@@`
  })

  // Whitespace normalization: collapse runs of spaces/tabs *within* prose lines,
  // trim trailing whitespace, collapse 3+ blank lines to 2.
  const lines = s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim())
  s = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  // Restore fenced code blocks last, preserving their original indentation.
  s = s.replace(/@@FENCE_SLOT_(\d+)@@/g, (_m, idx) => {
    const code = fences[Number(idx)] ?? ''
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`
  })

  return s.trim()
}

function stripInlineTags(s) {
  return s.replace(/<[^>]+>/g, '')
}

function listToMarkdown(inner, ordered) {
  const items = []
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi
  let m
  let n = 1
  while ((m = liRe.exec(inner)) !== null) {
    const text = decodeEntities(stripInlineTags(m[1])).replace(/\s+/g, ' ').trim()
    if (text) {
      items.push(ordered ? `${n}. ${text}` : `- ${text}`)
      n++
    }
  }
  return items.length ? `\n\n${items.join('\n')}\n\n` : ''
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
 * Handles nested elements of the same tag in a single linear pass.
 *
 * Earlier implementations re-scanned the whole string each iteration with a
 * non-greedy regex (P4.9 audit finding: O(N×depth) on adversarial input —
 * 1 MB HTML with deeply nested same-tag elements approached O(N²)).
 * stripElementOnce now collects all open/close events with two matchAll
 * passes, walks them with a depth counter, and concatenates the surviving
 * substrings — O(N + k log k) where k is the event count.
 *
 * @param {string} html
 * @param {string[]} tags - Lowercase tag names to strip.
 * @returns {string}
 */
function stripElements(html, tags) {
  let result = html
  for (const tag of tags) {
    result = stripElementOnce(result, tag)
  }
  return result
}

function stripElementOnce(html, tag) {
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?\\s*/?>`, 'gi')
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi')

  const events = []
  for (const m of html.matchAll(openRe)) {
    const isSelfClosing = m[0].endsWith('/>')
    events.push({ pos: m.index, end: m.index + m[0].length, kind: isSelfClosing ? 'self' : 'open' })
  }
  for (const m of html.matchAll(closeRe)) {
    events.push({ pos: m.index, end: m.index + m[0].length, kind: 'close' })
  }
  if (events.length === 0) return html
  events.sort((a, b) => a.pos - b.pos)

  // Walk events; ranges accumulates outermost matched [open, close] pairs
  // plus any orphan opens/closes that should be removed in isolation
  // (preserves the previous behavior of dropping just the tag and keeping
  // the content for unclosed elements).
  const ranges = []
  const stack = []
  let outerOpen = null
  for (const ev of events) {
    if (ev.kind === 'self') {
      if (stack.length === 0) ranges.push([ev.pos, ev.end])
      // a self-close inside an outer match is already covered by the outer range
    } else if (ev.kind === 'open') {
      if (stack.length === 0) outerOpen = ev
      stack.push(ev)
    } else if (ev.kind === 'close') {
      if (stack.length > 0) {
        stack.pop()
        if (stack.length === 0 && outerOpen) {
          ranges.push([outerOpen.pos, ev.end])
          outerOpen = null
        }
      } else {
        ranges.push([ev.pos, ev.end])
      }
    }
  }
  for (const open of stack) ranges.push([open.pos, open.end])

  ranges.sort((a, b) => a[0] - b[0])
  const out = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start < cursor) continue
    if (start > cursor) out.push(html.slice(cursor, start))
    cursor = end
  }
  if (cursor < html.length) out.push(html.slice(cursor))
  return out.join('')
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
  const renderText = opts.preserveStructure
    ? (frag) => htmlToMarkdown(frag, { linkResolver: opts.linkResolver })
    : htmlToPlainText

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

  const leadContent = renderText(parts[0]).trim()
  if (leadContent) {
    sections.push({ heading: null, content: leadContent })
  }

  // parts is: [lead, h2, content, h2, content, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const headingHtml = parts[i]
    const bodyHtml = parts[i + 1] ?? ''
    const heading = htmlToPlainText(headingHtml).trim() || null
    const content = renderText(bodyHtml).trim()
    if (heading || content) {
      sections.push({ heading, content })
    }
  }

  // If no sections were produced, return a single section with all content
  if (sections.length === 0) {
    const allContent = renderText(clean).trim()
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
/**
 * Detect a redirect-stub HTML page (e.g. swift.org legacy URLs that now point
 * at docs.swift.org). Returns the canonical destination URL, or null.
 *
 * Recognizes both the modern Hugo-style stub
 *   <title>Redirecting…</title>
 *   <link rel="canonical" href="…">
 *   <meta http-equiv="refresh" content="0; url=…">
 * and the bare HTTP-server "Document Has Moved" page.
 */
export function detectRedirectStub(html) {
  if (typeof html !== 'string') return null
  // Quick reject: must be small (<2KB) — real content pages are larger.
  if (html.length > 2048) return null
  // Either the title says "Redirecting" or the body says "Document Has Moved".
  const isStub = /<title[^>]*>\s*(Redirecting|Document Has Moved|Moved Permanently)/i.test(html)
  if (!isStub) return null
  // Prefer canonical link; fall back to meta-refresh URL; then any first href.
  const canonicalMatch = html.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]+href\s*=\s*["']([^"']+)["']/i)
  if (canonicalMatch) return canonicalMatch[1]
  const refreshMatch = html.match(/<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'][^"']*url\s*=\s*([^"';]+)/i)
  if (refreshMatch) return refreshMatch[1].trim()
  const hrefMatch = html.match(/<a[^>]+href\s*=\s*["']([^"']+)["']/i)
  return hrefMatch ? hrefMatch[1] : null
}

export function parseHtmlToNormalized(html, key, opts = {}) {
  const redirectTarget = detectRedirectStub(html)
  if (redirectTarget) {
    const document = createDocumentTemplate(
      key,
      opts.title ?? `Moved to ${redirectTarget}`,
      `This page has moved. The current location is ${redirectTarget}.`,
      null,
      {
        sourceType: opts.sourceType,
        kind: opts.kind ?? 'redirect',
        framework: opts.framework,
        url: redirectTarget,
        language: opts.language,
        sourceMetadata: opts.sourceMetadata,
      },
    )
    return {
      document,
      sections: [
        {
          sectionKind: 'discussion',
          heading: 'Page Moved',
          contentText: `This page is no longer maintained at its original location. The current canonical location is:\n\n[${redirectTarget}](${redirectTarget})`,
          contentJson: null,
          sortOrder: 0,
        },
      ],
      relationships: [],
    }
  }

  const extracted = extractHtmlContent(html, {
    containerSelector: opts.containerSelector,
    preserveStructure: opts.preserveStructure,
    linkResolver: opts.linkResolver,
  })

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

/**
 * Parse the Apple App Store Review Guidelines HTML page into structured sections.
 * Uses Bun's built-in HTMLRewriter (Cloudflare lol-html) — zero dependencies.
 */

const GUIDELINES_URL = 'https://developer.apple.com/app-store/review/guidelines/'
const ROOT_SLUG = 'app-store-review'

/**
 * Section number regex — matches patterns like: 1, 1.1, 1.1.1, 3.1.3(a), 5.1.1
 */
const SECTION_NUM_RE = /^(\d+(?:\.\d+)*(?:\([a-z]\))?)$/

/**
 * Parse the guidelines HTML into an array of section objects.
 * Each section has: { id, path, title, abstract, markdown, role, roleHeading, notarization, children }
 *
 * Strategy:
 *   Phase 1 — HTMLRewriter injects boundary markers at each data-sidenav element,
 *             strips ASR/NR badges and localization spans, and extracts metadata.
 *   Phase 2 — Split on markers, convert each chunk from HTML to Markdown.
 *
 * @param {string} html - The full HTML of the guidelines page
 * @returns {Promise<{ sections: Array, lastUpdated: string|null }>}
 */
export async function parseGuidelinesHtml(html) {
  // ── Phase 1: Extract metadata + inject markers ──────────────────────
  const sectionMeta = []  // { id, sidenavTitle, notarization }
  const MARKER = '<!--§SPLIT:'

  const rewriter = new HTMLRewriter()

  // Major sections: <h3 data-sidenav ...>
  rewriter.on('#content-container h3[data-sidenav]', {
    element(el) {
      const id = el.getAttribute('id') ?? ''
      const sidenavVal = el.getAttribute('data-sidenav')
      const nr = el.hasAttribute('data-nr')
      sectionMeta.push({ id, sidenavTitle: sidenavVal || null, notarization: nr, tag: 'h3' })
      el.before(`${MARKER}${sectionMeta.length - 1}-->`, { html: true })
    },
  })

  // Subsections: <li data-sidenav="...">
  rewriter.on('#content-container li[data-sidenav]', {
    element(el) {
      const id = el.getAttribute('id') ?? ''
      const sidenavVal = el.getAttribute('data-sidenav')
      const nr = el.hasAttribute('data-nr')
      sectionMeta.push({ id, sidenavTitle: sidenavVal || null, notarization: nr, tag: 'li' })
      el.before(`${MARKER}${sectionMeta.length - 1}-->`, { html: true })
    },
  })

  // Strip ASR/NR badge images and their wrapper spans
  rewriter.on('span.custom-tooltip-icon', { element(el) { el.remove() } })
  // Strip localization marker spans
  rewriter.on('span.loc-en-only', { element(el) { el.remove() } })
  rewriter.on('span.loc-j', { element(el) { el.remove() } })
  rewriter.on('span.loc-cj', { element(el) { el.remove() } })

  const transformed = await rewriter.transform(new Response(html)).text()

  // Extract just the content container
  const containerStart = transformed.indexOf('id="content-container"')
  if (containerStart === -1) throw new Error('Could not find #content-container in HTML')
  const contentHtml = transformed.slice(containerStart)

  // ── Phase 2: Split on markers + convert to Markdown ─────────────────
  const markerRe = /<!--§SPLIT:(\d+)-->/g
  const markerPositions = []
  let m
  while ((m = markerRe.exec(contentHtml)) !== null) {
    markerPositions.push({ index: m.index, metaIdx: parseInt(m[1], 10), marker: m[0] })
  }

  const sections = []

  for (let i = 0; i < markerPositions.length; i++) {
    const pos = markerPositions[i]
    const meta = sectionMeta[pos.metaIdx]
    const chunkStart = pos.index + pos.marker.length
    const chunkEnd = i + 1 < markerPositions.length ? markerPositions[i + 1].index : contentHtml.length

    let chunkHtml = contentHtml.slice(chunkStart, chunkEnd)

    // For <li data-sidenav> sections, the chunk starts inside the <li> — it includes
    // the content of that <li> plus any nested children. But it may also include
    // sibling <li> elements that are NOT data-sidenav (sub-items like 1.1.1, 1.1.2).
    // Those belong to this section.

    const markdown = await htmlToMarkdown(chunkHtml)
    const title = resolveTitle(meta, markdown)
    const sectionNumber = extractSectionNumber(title)
    const path = sectionNumber
      ? `${ROOT_SLUG}/${sectionNumber}`
      : `${ROOT_SLUG}/${meta.id}`
    const abstract = extractAbstract(markdown, title)

    const role = meta.tag === 'h3' ? 'collection' : 'article'
    const roleHeading = meta.tag === 'h3' ? 'Section' : 'Guideline'

    sections.push({
      id: meta.id,
      path,
      title,
      abstract,
      markdown,
      role,
      roleHeading,
      notarization: meta.notarization,
      sectionNumber,
      children: [],
    })
  }

  // Build parent→child relationships
  buildHierarchy(sections)

  // Extract last-updated date
  const lastUpdated = extractLastUpdated(contentHtml)

  return { sections, lastUpdated }
}

/**
 * Convert an HTML chunk to Markdown using HTMLRewriter.
 */
async function htmlToMarkdown(html) {
  // Wrap in a root element so HTMLRewriter processes it properly
  const wrapped = `<div id="md-root">${html}</div>`

  const parts = []
  let linkHref = null
  let inStrong = false
  let strongBuf = ''
  let listStack = []  // track list nesting: 'disc' | 'no-bullet'
  let inListItem = false
  let skipDepth = 0   // for elements we want to skip entirely

  const rw = new HTMLRewriter()

  // Skip navigation/sidebar elements that may be inside the content
  rw.on('.sidenav-container', { element(el) { skipDepth++; el.onEndTag(() => skipDepth--) } })
  rw.on('.sticky-container', { element(el) { skipDepth++; el.onEndTag(() => skipDepth--) } })
  rw.on('.form-checkbox', { element(el) { skipDepth++; el.onEndTag(() => skipDepth--) } })
  rw.on('#documentation', { element(el) { skipDepth++; el.onEndTag(() => skipDepth--) } })

  // Headings
  rw.on('h1, h2, h3', {
    element(el) {
      if (skipDepth > 0) return
      const level = parseInt(el.tagName[1])
      parts.push('\n' + '#'.repeat(level) + ' ')
      el.onEndTag(() => parts.push('\n\n'))
    },
  })

  // Paragraphs
  rw.on('p', {
    element(el) {
      if (skipDepth > 0) return
      el.onEndTag(() => parts.push('\n\n'))
    },
  })

  // Strong / bold
  rw.on('strong', {
    element(el) {
      if (skipDepth > 0) return
      inStrong = true
      strongBuf = ''
      el.onEndTag(() => {
        inStrong = false
        parts.push(`**${strongBuf}**`)
        strongBuf = ''
      })
    },
  })

  // Emphasis
  rw.on('em', {
    element(el) {
      if (skipDepth > 0) return
      parts.push('*')
      el.onEndTag(() => parts.push('*'))
    },
  })

  // Links
  rw.on('a[href]', {
    element(el) {
      if (skipDepth > 0) return
      linkHref = el.getAttribute('href')
      parts.push('[')
      el.onEndTag(() => {
        // Make relative URLs absolute
        let href = linkHref
        if (href && href.startsWith('/')) {
          href = `https://developer.apple.com${href}`
        }
        // Convert internal guideline anchors to section references
        if (href && href.startsWith('#')) {
          href = `#${href.slice(1)}`
        }
        parts.push(`](${href})`)
        linkHref = null
      })
    },
  })

  // Code
  rw.on('code', {
    element(el) {
      if (skipDepth > 0) return
      parts.push('`')
      el.onEndTag(() => parts.push('`'))
    },
  })

  // Lists
  rw.on('ul', {
    element(el) {
      if (skipDepth > 0) return
      const cls = el.getAttribute('class') ?? ''
      const type = cls.includes('disc') ? 'disc' : 'no-bullet'
      listStack.push(type)
      el.onEndTag(() => {
        listStack.pop()
        parts.push('\n')
      })
    },
  })

  rw.on('ol', {
    element(el) {
      if (skipDepth > 0) return
      listStack.push('ordered')
      el.onEndTag(() => {
        listStack.pop()
        parts.push('\n')
      })
    },
  })

  // List items
  rw.on('li', {
    element(el) {
      if (skipDepth > 0) return
      const depth = Math.max(0, listStack.length - 1)
      const indent = '  '.repeat(depth)
      const currentList = listStack[listStack.length - 1]

      if (currentList === 'disc') {
        parts.push(`${indent}- `)
      } else if (currentList === 'ordered') {
        parts.push(`${indent}1. `)
      }
      // 'no-bullet' list items get no prefix — they're guideline sections
      inListItem = true
      el.onEndTag(() => {
        inListItem = false
        parts.push('\n')
      })
    },
  })

  // Line breaks
  rw.on('br', {
    element() {
      if (skipDepth > 0) return
      parts.push('\n')
    },
  })

  // Images (skip, they're mostly ASR/NR badges already stripped)
  rw.on('img', {
    element(el) {
      // Already stripped ASR badges in phase 1, skip any remaining
    },
  })

  // Span elements with id (section number anchors) — skip the span, keep flow
  rw.on('span[id]', {
    element() {
      // These are anchor spans like <span id="1.1"></span>, skip silently
    },
  })

  // Text handler — capture all text
  rw.onDocument({
    text(chunk) {
      if (skipDepth > 0) return
      if (!chunk.text) return
      if (inStrong) {
        strongBuf += chunk.text
      } else {
        parts.push(chunk.text)
      }
    },
  })

  await rw.transform(new Response(wrapped)).text()

  // Clean up the markdown
  let md = parts.join('')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ')       // non-breaking space
    .replace(/\t/g, ' ')           // tabs
    .replace(/^[ \t]+/gm, '')      // leading whitespace on each line (HTML indentation)
    .replace(/ {2,}/g, ' ')        // collapse multiple spaces
    .replace(/\n{3,}/g, '\n\n')    // collapse blank lines
    .trim()

  return md
}

/**
 * Resolve the section title from metadata and markdown content.
 */
function resolveTitle(meta, markdown) {
  // data-sidenav attribute value is the cleanest title source for <li> elements
  if (meta.sidenavTitle) {
    return meta.sidenavTitle.trim()
  }

  // For <h3> elements without a data-sidenav value, extract from markdown
  // The first line of markdown is typically "### N. Title"
  const firstLine = markdown.split('\n').find(l => l.trim())
  if (firstLine) {
    // Strip markdown heading prefix and numbering-dot prefix
    let title = firstLine.replace(/^#+\s*/, '').trim()
    return title
  }

  // Fallback to id
  return meta.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Extract a section number like "1.1" or "3.1.3(a)" from a title.
 */
function extractSectionNumber(title) {
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
function extractAbstract(markdown, title) {
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
function extractLastUpdated(html) {
  const m = html.match(/Last Updated:\s*<a[^>]*>([^<]+)<\/a>/)
  return m ? m[1].trim() : null
}

/**
 * Build parent→child relationships from section numbers.
 * E.g., section "1" is parent of "1.1", which is parent of "1.1.1".
 */
function buildHierarchy(sections) {
  const byNumber = new Map()
  for (const s of sections) {
    if (s.sectionNumber) byNumber.set(s.sectionNumber, s)
  }

  for (const s of sections) {
    if (!s.sectionNumber) continue
    const parent = findParentNumber(s.sectionNumber)
    if (parent && byNumber.has(parent)) {
      byNumber.get(parent).children.push(s.path)
    }
  }
}

/**
 * Given "1.1.1", return "1.1". Given "3.1.3(a)", return "3.1.3".
 */
function findParentNumber(num) {
  // Handle parenthetical suffixes: "3.1.3(a)" → parent is "3.1.3"
  if (num.includes('(')) {
    return num.replace(/\([a-z]\)$/, '')
  }
  // Handle dotted numbers: "1.1.1" → "1.1", "1.1" → "1"
  const lastDot = num.lastIndexOf('.')
  if (lastDot === -1) return null
  return num.slice(0, lastDot)
}

export { ROOT_SLUG, GUIDELINES_URL }

import { ParseError } from '../lib/errors.js'

/**
 * Parse the Apple App Store Review Guidelines HTML page into structured sections.
 * Uses Bun's built-in HTMLRewriter (Cloudflare lol-html) — zero dependencies.
 */

const GUIDELINES_URL = 'https://developer.apple.com/app-store/review/guidelines/'
const ROOT_SLUG = 'app-store-review'

/**
 * Section number regex — matches patterns like: 1, 1.1, 1.1.1, 3.1.3(a), 5.1.1
 */
const _SECTION_NUM_RE = /^(\d+(?:\.\d+)*(?:\([a-z]\))?)$/

import { buildHierarchy } from './guidelines/hierarchy.js'
/**
 * Parse the guidelines HTML into an array of section objects.
 * Each section has: { id, path, title, abstract, markdown, role, roleHeading, notarization, children }
 *
 * Strategy:
 *   Pass 1 — HTMLRewriter injects boundary markers at each data-sidenav element,
 *            strips ASR/NR badges and localization spans, and extracts metadata.
 *   Pass 2 — Split on markers, convert each chunk from HTML to Markdown.
 *
 * @param {string} html - The full HTML of the guidelines page
 * @returns {Promise<{ sections: Array, lastUpdated: string|null }>}
 */
import { htmlToMarkdown } from './guidelines/html-to-markdown.js'
import { extractAbstract, extractLastUpdated, extractSectionNumber, resolveTitle } from './guidelines/section-meta.js'

/** @param {string} html */
export async function parseGuidelinesHtml(html) {
  // ── Pass 1: Extract metadata + inject markers ──────────────────────
  /** @type {any[]} */
  const sectionMeta = [] // { id, sidenavTitle, notarization }
  const MARKER = '<!--§SPLIT:'

  const rewriter = new HTMLRewriter()

  // Major sections (<h3 data-sidenav>) and subsections (<li data-sidenav>)
  // capture identically — only the selector and the recorded tag differ.
  /** @param {string} tag */
  const captureSidenav = (tag) => ({
    /** @param {any} el */
    element(el) {
      const id = el.getAttribute('id') ?? ''
      const sidenavVal = el.getAttribute('data-sidenav')
      const nr = el.hasAttribute('data-nr')
      sectionMeta.push({ id, sidenavTitle: sidenavVal || null, notarization: nr, tag })
      el.before(`${MARKER}${sectionMeta.length - 1}-->`, { html: true })
    },
  })
  rewriter.on('#content-container h3[data-sidenav]', captureSidenav('h3'))
  rewriter.on('#content-container li[data-sidenav]', captureSidenav('li'))

  // Strip ASR/NR badge images and their wrapper spans
  rewriter.on('span.custom-tooltip-icon', {
    element(el) {
      el.remove()
    },
  })
  // Strip localization marker spans
  rewriter.on('span.loc-en-only', {
    element(el) {
      el.remove()
    },
  })
  rewriter.on('span.loc-j', {
    element(el) {
      el.remove()
    },
  })
  rewriter.on('span.loc-cj', {
    element(el) {
      el.remove()
    },
  })

  const transformed = await rewriter.transform(new Response(html)).text()

  // Extract just the content container
  const containerStart = transformed.indexOf('id="content-container"')
  if (containerStart === -1) throw new ParseError('Could not find #content-container in HTML')
  const contentHtml = transformed.slice(containerStart)

  // ── Pass 2: Split on markers + convert to Markdown ─────────────────
  const markerRe = /<!--§SPLIT:(\d+)-->/g
  const markerPositions = []
  for (const m of contentHtml.matchAll(markerRe)) {
    markerPositions.push({ index: m.index, metaIdx: Number.parseInt(m[1], 10), marker: m[0] })
  }

  const sections = []

  for (let i = 0; i < markerPositions.length; i++) {
    const pos = markerPositions[i]
    const meta = sectionMeta[pos.metaIdx]
    const chunkStart = pos.index + pos.marker.length
    const chunkEnd = i + 1 < markerPositions.length ? markerPositions[i + 1].index : contentHtml.length

    const chunkHtml = contentHtml.slice(chunkStart, chunkEnd)

    // For <li data-sidenav> sections, the chunk starts inside the <li> — it includes
    // the content of that <li> plus any nested children. But it may also include
    // sibling <li> elements that are NOT data-sidenav (sub-items like 1.1.1, 1.1.2).
    // Those belong to this section.

    const markdown = await htmlToMarkdown(chunkHtml)
    const title = resolveTitle(meta, markdown)
    const sectionNumber = extractSectionNumber(title)
    const path = sectionNumber ? `${ROOT_SLUG}/${sectionNumber}` : `${ROOT_SLUG}/${meta.id}`
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
export { GUIDELINES_URL, ROOT_SLUG }

/**
 * HTML content extraction utilities for converting HTML documentation pages
 * into the normalized document model.
 *
 * Used by Swift.org and Apple Archive adapters.
 * No external HTML parser dependency — regex/string-based parsing.
 *
 * Constants live in parse-html/constants.js, entity decoding in
 * parse-html/entities.js, the text/markdown converters in
 * parse-html/text-extract.js, the linear strip-elements pass in
 * parse-html/strip-elements.js, the CSS-shaped selector matcher in
 * parse-html/selectors.js, and meta + redirect detection in
 * parse-html/meta.js. This file exposes the public
 * extractHtmlContent + parseHtmlToNormalized surface and re-exports the
 * smaller helpers callers used to import.
 */

import { createDocumentTemplate } from './document-template.js'
import { SECTION_SPLIT_REGEX_BY_TAG, STRIP_ELEMENTS } from './parse-html/constants.js'
import { htmlToMarkdown, htmlToPlainText } from './parse-html/text-extract.js'
import { stripElements } from './parse-html/strip-elements.js'
import { extractBySelector } from './parse-html/selectors.js'
import { detectRedirectStub, extractMetaInfo } from './parse-html/meta.js'

export { htmlToMarkdown, htmlToPlainText, extractMetaInfo, detectRedirectStub }

/**
 * Extract structured content from an HTML documentation page.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {string} [opts.containerSelector] - CSS-like selector for main content.
 * @param {boolean} [opts.preserveStructure] - Use htmlToMarkdown for body text.
 * @param {(href: string) => string|null} [opts.linkResolver]
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
    for (const sel of ['main', 'article', '.content', '#content', '#contents']) {
      const found = extractBySelector(html, sel)
      if (found) {
        container = found
        break
      }
    }
  }

  if (!container) {
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

/**
 * Parse an HTML page into the canonical normalized document model.
 *
 * @param {string} html
 * @param {string} key  - Canonical path key, e.g. 'swift/generics'.
 * @param {object} [opts]
 * @returns {{ document: object, sections: object[], relationships: [] }}
 */
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

  // abstractText: description if available, else first non-empty paragraph
  // of the lead section content.
  let abstractText = description || null
  if (!abstractText && htmlSections.length > 0) {
    const leadContent = htmlSections[0].content
    if (leadContent) {
      abstractText = leadContent.split('\n\n')[0].trim() || null
    }
  }

  // headings: space-joined texts of all section headings for FTS
  const headingTexts = htmlSections.map(s => s.heading).filter(Boolean)
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

  if (description) {
    sections.push({
      sectionKind: 'abstract',
      heading: null,
      contentText: description,
      contentJson: null,
      sortOrder: order++,
    })
  }

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

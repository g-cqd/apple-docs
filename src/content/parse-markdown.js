/**
 * Markdown parsing utilities that convert Markdown source files into the
 * normalized document model used throughout the app.
 *
 * Used by Swift Evolution and Swift Book adapters.
 */

import { createDocumentTemplate } from './document-template.js'

// ---------------------------------------------------------------------------
// extractFrontmatter
// ---------------------------------------------------------------------------

/**
 * Detect YAML frontmatter between `---` delimiters at the start of the file.
 *
 * Parses simple key: value pairs, multi-line values (indented continuation
 * lines), and list items (lines starting with `- `).
 *
 * @param {string} markdown - Raw Markdown source.
 * @returns {{ frontmatter: object|null, body: string }}
 */
export function extractFrontmatter(markdown) {
  if (typeof markdown !== 'string') return { frontmatter: null, body: markdown ?? '' }

  // Frontmatter must start at the very beginning of the file
  if (!markdown.startsWith('---')) return { frontmatter: null, body: markdown }

  const afterOpen = markdown.slice(3)
  // Accept `---` or `---\n` as opening delimiter
  if (afterOpen.length > 0 && afterOpen[0] !== '\n' && afterOpen[0] !== '\r') {
    return { frontmatter: null, body: markdown }
  }

  const closingIndex = afterOpen.indexOf('\n---')
  if (closingIndex === -1) return { frontmatter: null, body: markdown }

  const yamlBlock = afterOpen.slice(afterOpen[0] === '\n' ? 1 : 2, closingIndex)

  // Everything after the closing `---` line is the body
  const afterClose = afterOpen.slice(closingIndex + 4) // skip \n---
  const body = afterClose.startsWith('\n') ? afterClose.slice(1) : afterClose

  const frontmatter = parseYaml(yamlBlock)

  return { frontmatter, body }
}

/**
 * Minimal YAML parser that handles:
 * - Simple scalar:  `key: value`
 * - Quoted scalar:  `key: "value"` or `key: 'value'`
 * - Multi-line:     continuation lines that start with whitespace (joined)
 * - Lists:          `key:\n  - item1\n  - item2`
 * - Boolean/number coercion is intentionally avoided; all values are strings
 *   unless they form a list.
 *
 * @param {string} yaml
 * @returns {object}
 */
function parseYaml(yaml) {
  const result = {}
  const lines = yaml.split('\n')

  /** @type {string|null} */
  let currentKey = null
  /** @type {string[]|null} */
  let currentList = null
  /** @type {string|null} */
  let currentScalar = null

  const flush = () => {
    if (currentKey === null) return
    if (currentList !== null) {
      result[currentKey] = currentList
    } else if (currentScalar !== null) {
      result[currentKey] = currentScalar.trim()
    }
    currentKey = null
    currentList = null
    currentScalar = null
  }

  for (const rawLine of lines) {
    // Skip fully blank lines between keys
    if (rawLine.trim() === '') {
      flush()
      continue
    }

    const isListItem = /^[ \t]+-[ \t]+(.*)$/.exec(rawLine)
    const isKeyValue = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(rawLine)
    const isContinuation = /^[ \t]+(.+)$/.exec(rawLine)

    if (isListItem) {
      // List item under the current key
      if (currentKey !== null) {
        if (currentList === null) currentList = []
        currentList.push(isListItem[1].trim())
      }
    } else if (isKeyValue) {
      flush()
      currentKey = isKeyValue[1]
      const rawValue = isKeyValue[2].trim()

      if (rawValue === '' || rawValue === '|' || rawValue === '>') {
        // Value will follow on subsequent lines (block scalar or list)
        currentScalar = null
      } else {
        // Unquote if wrapped in matching quotes
        const unquoted = unquoteYaml(rawValue)
        currentScalar = unquoted
      }
    } else if (isContinuation && currentKey !== null && currentList === null) {
      // Multi-line scalar continuation
      const piece = isContinuation[1].trim()
      currentScalar = currentScalar !== null ? `${currentScalar} ${piece}` : piece
    }
    // Unrecognised lines are silently skipped
  }

  flush()
  return result
}

/**
 * Strip surrounding single or double quotes from a YAML scalar value.
 *
 * @param {string} value
 * @returns {string}
 */
function unquoteYaml(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

// ---------------------------------------------------------------------------
// splitByHeadings
// ---------------------------------------------------------------------------

/**
 * Split a Markdown body by heading level (default `##`).
 *
 * @param {string} body    - Markdown content (no frontmatter).
 * @param {number} [level] - ATX heading level to split on (default 2).
 * @returns {Array<{ heading: string|null, content: string }>}
 */
export function splitByHeadings(body, level = 2) {
  if (typeof body !== 'string') return []

  const prefix = '#'.repeat(level)
  // Match ATX headings of exactly `level` hashes followed by a space
  // The regex captures the heading text and the boundary between sections
  const _headingRe = new RegExp(`^${prefix}(?!#) +(.+)$`, 'm')

  const sections = []

  /**
   * @param {string|null} heading
   * @param {string} content
   */
  const _pushSection = (heading, content) => {
    const trimmed = content.trim()
    if (trimmed !== '' || heading !== null) {
      sections.push({ heading, content: trimmed })
    }
  }

  // Split on each occurrence of the heading pattern
  const splitRe = new RegExp(`^(${prefix}(?!#) +.+)$`, 'mg')
  const _lastIndex = 0
  const _lastHeading = null
  let _match

  const _preText = []
  splitRe.lastIndex = 0

  // Collect all heading positions
  const headingMatches = []
  let m
  const scanRe = new RegExp(`^(${prefix}(?!#) +(.+))$`, 'mg')
  while ((m = scanRe.exec(body)) !== null) {
    headingMatches.push({ index: m.index, full: m[1], text: m[2], end: m.index + m[0].length })
  }

  if (headingMatches.length === 0) {
    // No headings at this level — return single section with null heading
    const trimmed = body.trim()
    if (trimmed) return [{ heading: null, content: trimmed }]
    return []
  }

  // Content before the first heading
  const beforeFirst = body.slice(0, headingMatches[0].index)
  if (beforeFirst.trim()) {
    sections.push({ heading: null, content: beforeFirst.trim() })
  }

  for (let i = 0; i < headingMatches.length; i++) {
    const current = headingMatches[i]
    const next = headingMatches[i + 1]
    const contentStart = current.end
    const contentEnd = next ? next.index : body.length
    const content = body.slice(contentStart, contentEnd).trim()

    if (current.text.trim() !== '' || content !== '') {
      sections.push({ heading: current.text.trim(), content })
    }
  }

  return sections
}

// ---------------------------------------------------------------------------
// parseMarkdownToSections
// ---------------------------------------------------------------------------

/**
 * Parse a Markdown source file into the canonical normalized document model.
 *
 * @param {string} markdown  - Raw Markdown source (may include frontmatter).
 * @param {string} key       - Canonical path key, e.g. 'swift-evolution/SE-0400'.
 * @param {object} [opts]
 * @param {string} [opts.sourceType]
 * @param {string} [opts.kind]
 * @param {string} [opts.framework]
 * @param {string} [opts.url]
 * @param {string} [opts.language]
 * @param {object} [opts.sourceMetadata]
 * @returns {{ document: object, sections: object[], relationships: [] }}
 */
export function parseMarkdownToSections(markdown, key, opts = {}) {
  const { frontmatter, body } = extractFrontmatter(markdown ?? '')

  // ── Title ─────────────────────────────────────────────────────────────────
  // Prefer an explicit `# Heading` at the start of the body, then fall back
  // to frontmatter.title.
  let title = null
  let bodyWithoutH1 = body

  const h1Re = /^# +(.+)$/m
  const h1Match = h1Re.exec(body)
  if (h1Match) {
    title = h1Match[1].trim()
    // Remove the h1 line and any leading blank lines from the body we process
    bodyWithoutH1 = body.slice(0, h1Match.index) +
      body.slice(h1Match.index + h1Match[0].length)
    bodyWithoutH1 = bodyWithoutH1.replace(/^\n+/, '')
  }

  if (!title && frontmatter?.title) {
    title = String(frontmatter.title).trim()
  }

  // ── Abstract ──────────────────────────────────────────────────────────────
  // First paragraph before the first ## heading
  const abstractText = extractFirstParagraph(bodyWithoutH1)

  // ── Headings for FTS ──────────────────────────────────────────────────────
  const headingTexts = []
  const allH2Re = /^## +(.+)$/mg
  let hm
  while ((hm = allH2Re.exec(bodyWithoutH1)) !== null) {
    headingTexts.push(hm[1].trim())
  }
  const headings = headingTexts.length > 0 ? headingTexts.join(' ') : null

  // ── Document ──────────────────────────────────────────────────────────────
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

  // 1. Abstract section — first paragraph of body
  if (abstractText) {
    sections.push({
      sectionKind: 'abstract',
      heading: null,
      contentText: abstractText,
      contentJson: null,
      sortOrder: order++,
    })
  }

  // 2. Discussion sections — one per ## block
  const h2Sections = splitByHeadings(bodyWithoutH1, 2)
  for (const section of h2Sections) {
    if (section.heading === null) continue // pre-heading content already used as abstract
    sections.push({
      sectionKind: 'discussion',
      heading: section.heading,
      contentText: section.content || null,
      contentJson: null,
      sortOrder: order++,
    })
  }

  // ── Relationships ─────────────────────────────────────────────────────────
  // Markdown sources don't carry typed relationships
  const relationships = []

  return { document, sections, relationships }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first paragraph from a Markdown body.
 * A paragraph is any block of non-blank text before the first blank line
 * that is not a heading, code fence, or list marker.
 *
 * @param {string} body
 * @returns {string|null}
 */
function extractFirstParagraph(body) {
  if (!body) return null

  // Stop at the first ## heading or at a blank line that precedes a ## heading
  // Strategy: take everything before the first ## heading, then extract the
  // first non-empty paragraph from that block.
  const h2Index = body.search(/^## /m)
  const beforeH2 = h2Index === -1 ? body : body.slice(0, h2Index)

  // Split into paragraphs (separated by one or more blank lines)
  const paragraphs = beforeH2.split(/\n\s*\n/)

  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue
    // Skip headings, code fences, horizontal rules
    if (trimmed.startsWith('#')) continue
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) continue
    if (/^[-*_]{3,}$/.test(trimmed)) continue
    return trimmed
  }

  return null
}

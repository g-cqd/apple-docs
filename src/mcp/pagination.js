/**
 * MCP response pagination.
 *
 * Public entry points:
 *   - createMcpTextResult       — wraps a payload as the MCP `content` array.
 *   - paginateArrayField        — generic array paginator for tools whose
 *                                  response is `{ field: [...] }`.
 *   - paginateDocumentPayload   — document-shaped paginator: dispatches to
 *                                  matched-mode, text-window, or section-
 *                                  bucketing depending on payload shape.
 *   - buildMatchedDocumentPayload — narrow a doc to a substring's match
 *                                   excerpts before pagination.
 *
 * Phase B decomposition: text-shaping helpers live in pagination/text-utils.js,
 * page-plan / fragment builders in pagination/page-builder.js. This module
 * is the strategy-dispatch layer.
 */

import {
  PaginationItemTooLargeError,
  PAGINATION_LIMITS,
  buildArrayPages,
  buildArrayPaginationPlan,
  buildDocumentPagePayload,
  buildTextPaginationPlan,
  splitOversizedSection,
  withDocumentPageInfo,
} from './pagination/page-builder.js'
import {
  excerptAroundMatch,
  serializePayload,
} from './pagination/text-utils.js'

export const MIN_PAGINATED_MAX_CHARS = 512

const { MAX_PLAN_ITERATIONS } = PAGINATION_LIMITS

export function createMcpTextResult(payload) {
  const text = serializePayload(payload)
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload,
  }
}

export function paginateArrayField(payload, fieldName, opts = {}) {
  const { maxChars, page = 1, strategy = 'items' } = opts
  if (maxChars == null) return payload

  const items = Array.isArray(payload?.[fieldName]) ? payload[fieldName] : []
  const { pages, totalPages } = buildArrayPaginationPlan({
    items,
    maxChars,
    initialTotalPages: 1,
    buildPayload: (slice, pageIndex, assumedTotalPages) => ({
      ...payload,
      [fieldName]: slice,
      pageInfo: {
        page: pageIndex,
        totalPages: assumedTotalPages,
        maxChars,
        hasNextPage: pageIndex < assumedTotalPages,
        hasPreviousPage: pageIndex > 1,
        strategy,
        totalItems: items.length,
        pageItems: slice.length,
      },
    }),
  })

  if (page < 1 || page > totalPages) {
    throw new Error(`Page ${page} is out of range. Valid pages: 1-${totalPages}.`)
  }

  return pages[page - 1]
}

export function paginateDocumentPayload(payload, opts = {}) {
  const { maxChars, page = 1, document = payload?.metadata ?? null } = opts
  if (maxChars == null) return payload

  const sections = Array.isArray(payload?.sections) ? payload.sections : []
  const sanitizedBase = { ...payload, sections: [] }

  const singlePage = withDocumentPageInfo(sanitizedBase, {
    page: 1,
    totalPages: 1,
    maxChars,
    strategy: payload?.matches ? 'matches' : 'document',
    totalSections: sections.length,
    pageSections: sections.length,
  })

  if (serializePayload(singlePage).length <= maxChars) {
    if (page !== 1) {
      throw new Error('Page 1 is the only available page for this response.')
    }
    return singlePage
  }

  if (payload?.matches) {
    return paginateMatchedDocumentPayload(payload, { maxChars, page })
  }

  if (sections.length === 0) {
    return paginateTextWindowPayload(payload, { maxChars, page })
  }

  // Section-bucket strategy: bin-pack sections under maxChars. When a
  // single section overflows on its own, recursively split it along
  // paragraph / line / character-window boundaries until each fragment
  // fits. Bail to text-window mode if even the smallest unit overflows.
  const units = sections.map(section => ({
    ...section,
    contentText: section?.contentText ?? section?.content_text ?? '',
  }))

  let assumedTotalPages = 1
  let pagePayloads = null
  let strategy = 'sections'

  for (let i = 0; i < MAX_PLAN_ITERATIONS; i++) {
    try {
      const pages = buildArrayPages({
        items: units,
        totalPages: assumedTotalPages,
        maxChars,
        buildPayload: (slice, pageIndex, totalPages) => buildDocumentPagePayload({
          payload, document,
          pageSections: slice,
          page: pageIndex,
          totalPages,
          maxChars,
          strategy,
          totalSectionUnits: units.length,
        }),
      })
      pagePayloads = pages
      if (pages.length === assumedTotalPages) break
      assumedTotalPages = pages.length
    } catch (error) {
      if (!(error instanceof PaginationItemTooLargeError)) throw error
      const oversized = units[error.itemIndex]
      const currentLength = String(oversized?.contentText ?? oversized?.content_text ?? '').length
      const split = splitOversizedSection(
        oversized,
        Math.max(
          PAGINATION_LIMITS.MIN_SECTION_FRAGMENT_CHARS,
          Math.min(Math.floor(currentLength / 2), Math.floor(maxChars * 0.75)),
        ),
      )
      if (split.length <= 1) {
        return paginateTextWindowPayload(payload, { maxChars, page })
      }
      units.splice(error.itemIndex, 1, ...split)
      assumedTotalPages = Math.max(assumedTotalPages, 1)
      strategy = 'section-fragments'
      pagePayloads = null
    }
  }

  if (!pagePayloads) {
    return paginateTextWindowPayload(payload, { maxChars, page })
  }

  if (page < 1 || page > pagePayloads.length) {
    throw new Error(`Page ${page} is out of range. Valid pages: 1-${pagePayloads.length}.`)
  }

  return pagePayloads[page - 1]
}

export function buildMatchedDocumentPayload(payload, opts = {}) {
  const {
    match,
    caseSensitive = false,
    contextChars = 140,
    maxMatches = 5,
  } = opts

  const sections = Array.isArray(payload?.sections) ? payload.sections : []
  const matches = []
  const needle = caseSensitive ? match : match.toLowerCase()

  for (const section of sections) {
    const haystack = section?.contentText ?? section?.content_text ?? ''
    if (!haystack) continue
    const scan = caseSensitive ? haystack : haystack.toLowerCase()
    let offset = 0
    while (offset < scan.length) {
      const index = scan.indexOf(needle, offset)
      if (index < 0) break
      matches.push({
        sectionKind: section?.sectionKind ?? section?.section_kind ?? null,
        heading: section?.heading ?? null,
        excerpt: excerptAroundMatch(haystack, index, match.length, contextChars),
      })
      if (matches.length >= maxMatches) break
      offset = index + Math.max(needle.length, 1)
    }
    if (matches.length >= maxMatches) break
  }

  return {
    ...payload,
    content: null,
    matches,
    sections: [],
    note: matches.length === 0
      ? `No matches found for "${match}".`
      : `Showing ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${match}".`,
  }
}

function paginateTextWindowPayload(payload, opts) {
  const { maxChars, page = 1 } = opts
  const content = String(payload?.content ?? '')

  const plan = buildTextPaginationPlan({
    text: content,
    maxChars,
    buildPayload: (slice, pageIndex, totalPages) => withDocumentPageInfo({
      ...payload,
      note: undefined,
      content: slice,
      sections: [],
    }, {
      page: pageIndex,
      totalPages,
      maxChars,
      strategy: 'text-window',
      totalSections: 0,
      pageSections: 0,
    }),
  })

  if (page < 1 || page > plan.pages.length) {
    throw new Error(`Page ${page} is out of range. Valid pages: 1-${plan.pages.length}.`)
  }

  return plan.pages[page - 1]
}

function paginateMatchedDocumentPayload(payload, opts) {
  const { maxChars, page = 1 } = opts
  const matches = Array.isArray(payload?.matches) ? payload.matches : []
  const { pages, totalPages } = buildArrayPaginationPlan({
    items: matches,
    maxChars,
    initialTotalPages: 1,
    buildPayload: (slice, pageIndex, assumedTotalPages) => ({
      ...payload,
      note: undefined,
      matches: slice,
      content: null,
      pageInfo: {
        page: pageIndex,
        totalPages: assumedTotalPages,
        maxChars,
        hasNextPage: pageIndex < assumedTotalPages,
        hasPreviousPage: pageIndex > 1,
        strategy: 'matches',
        totalItems: matches.length,
        pageItems: slice.length,
      },
    }),
  })

  if (page < 1 || page > totalPages) {
    throw new Error(`Page ${page} is out of range. Valid pages: 1-${totalPages}.`)
  }

  return pages[page - 1]
}

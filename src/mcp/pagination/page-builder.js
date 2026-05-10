// Pagination plan builders. Two strategies — array (split on item
// boundaries) and text-window (split inside a single string body) — both
// driven by a binary search against a serialized-length budget.
//
// Pulled out of mcp/pagination.js as part of Phase B.

import { renderMarkdown } from '../../content/render-markdown.js'
import {
  serializePayload,
  skipWhitespace,
  sliceTextAtBoundary,
  splitByCharacterWindow,
  groupChunks,
  splitText,
} from './text-utils.js'

const MAX_PLAN_ITERATIONS = 12
const MIN_SECTION_FRAGMENT_CHARS = 160

export class PaginationItemTooLargeError extends Error {
  constructor(message, itemIndex) {
    super(message)
    this.name = 'PaginationItemTooLargeError'
    this.itemIndex = itemIndex
  }
}

/**
 * Iteratively converge on the page count: a small payload at totalPages=1
 * may serialize past the budget once a `totalPages: N` field is added.
 * Each iteration re-runs buildArrayPages with the previous count until
 * the page-count stabilises (or MAX_PLAN_ITERATIONS bails).
 */
export function buildArrayPaginationPlan({ items, maxChars, initialTotalPages, buildPayload }) {
  let assumedTotalPages = initialTotalPages
  let pages = []

  for (let i = 0; i < MAX_PLAN_ITERATIONS; i++) {
    pages = buildArrayPages({ items, totalPages: assumedTotalPages, maxChars, buildPayload })
    if (pages.length === assumedTotalPages) break
    assumedTotalPages = pages.length
  }

  return { pages, totalPages: pages.length }
}

export function buildArrayPages({ items, totalPages, maxChars, buildPayload }) {
  if (items.length === 0) {
    const empty = buildPayload([], 1, 1)
    ensureFits(empty, maxChars, 0)
    return [empty]
  }

  const pages = []
  let start = 0
  let pageIndex = 1

  while (start < items.length) {
    let low = start + 1
    let high = items.length
    let best = start

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const candidate = buildPayload(items.slice(start, mid), pageIndex, totalPages)
      const length = serializePayload(candidate).length
      if (length <= maxChars) {
        best = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    if (best === start) {
      throw new PaginationItemTooLargeError(
        `A single item exceeds the maxChars budget (${maxChars}). Increase maxChars or narrow the query.`,
        start,
      )
    }

    pages.push(buildPayload(items.slice(start, best), pageIndex, totalPages))
    start = best
    pageIndex++
  }

  return pages
}

export function buildTextPaginationPlan({ text, maxChars, buildPayload }) {
  let assumedTotalPages = 1
  let pages = []

  for (let i = 0; i < MAX_PLAN_ITERATIONS; i++) {
    pages = buildTextPages({ text, totalPages: assumedTotalPages, maxChars, buildPayload })
    if (pages.length === assumedTotalPages) break
    assumedTotalPages = pages.length
  }

  return { pages, totalPages: pages.length }
}

function buildTextPages({ text, totalPages, maxChars, buildPayload }) {
  if (!text) {
    const empty = buildPayload('', 1, 1)
    ensureFits(empty, maxChars, 0)
    return [empty]
  }

  const pages = []
  let start = 0
  let pageIndex = 1

  while (start < text.length) {
    start = skipWhitespace(text, start)
    if (start >= text.length) break

    let low = start + 1
    let high = text.length
    let best = start

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const slice = sliceTextAtBoundary(text, start, mid)
      const candidate = buildPayload(slice.text, pageIndex, totalPages)
      const length = serializePayload(candidate).length
      if (length <= maxChars) {
        best = slice.end
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    if (best === start) {
      throw new Error(`The requested maxChars budget (${maxChars}) is too small to return any content.`)
    }

    pages.push(buildPayload(text.slice(start, best).trim(), pageIndex, totalPages))
    start = best
    pageIndex++
  }

  return pages
}

function ensureFits(payload, maxChars, itemIndex) {
  if (serializePayload(payload).length > maxChars) {
    throw new PaginationItemTooLargeError(
      `A single page exceeds the maxChars budget (${maxChars}). Increase maxChars.`,
      itemIndex,
    )
  }
}

/**
 * When a single section overflows the budget, split its contentText along
 * paragraph / line / character-window boundaries until each fragment fits.
 * Returns at most one fragment per boundary; if even the smallest unit
 * (single character window) won't fit, returns the original section so
 * the caller can fall back to text-window mode at the document level.
 */
export function splitOversizedSection(section, targetChars) {
  const text = section?.contentText ?? section?.content_text ?? ''
  if (!text || text.length <= MIN_SECTION_FRAGMENT_CHARS) return [section]
  const effectiveTarget = Math.max(MIN_SECTION_FRAGMENT_CHARS, Math.min(targetChars, Math.max(text.length - 1, 1)))

  const pieces = groupChunks(splitText(text), effectiveTarget)
  if (pieces.length <= 1) {
    return splitByCharacterWindow(text, effectiveTarget).map(contentText => ({
      ...section,
      contentText,
      contentJson: null,
    }))
  }

  return pieces.map(contentText => ({
    ...section,
    contentText,
    contentJson: null,
  }))
}

export function withDocumentPageInfo(payload, pageInfo) {
  return {
    ...payload,
    pageInfo: {
      page: pageInfo.page,
      totalPages: pageInfo.totalPages,
      maxChars: pageInfo.maxChars,
      hasNextPage: pageInfo.page < pageInfo.totalPages,
      hasPreviousPage: pageInfo.page > 1,
      strategy: pageInfo.strategy,
      totalSections: pageInfo.totalSections,
      pageSections: pageInfo.pageSections,
    },
  }
}

export function buildDocumentPagePayload({
  payload,
  document,
  pageSections,
  page,
  totalPages,
  maxChars,
  strategy,
  totalSectionUnits,
}) {
  const content = renderMarkdown(document ?? payload?.metadata ?? {}, pageSections, {
    includeFrontMatter: page === 1,
    includeTitle: page === 1,
  })

  return withDocumentPageInfo({
    ...payload,
    note: undefined,
    content,
    sections: [],
  }, {
    page,
    totalPages,
    maxChars,
    strategy,
    totalSections: totalSectionUnits,
    pageSections: pageSections.length,
  })
}

export const PAGINATION_LIMITS = {
  MAX_PLAN_ITERATIONS,
  MIN_SECTION_FRAGMENT_CHARS,
}

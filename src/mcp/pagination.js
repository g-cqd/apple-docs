import { renderMarkdown } from '../content/render-markdown.js'

export const MIN_PAGINATED_MAX_CHARS = 512

const MAX_PLAN_ITERATIONS = 12
const MIN_SECTION_FRAGMENT_CHARS = 160

class PaginationItemTooLargeError extends Error {
  constructor(message, itemIndex) {
    super(message)
    this.name = 'PaginationItemTooLargeError'
    this.itemIndex = itemIndex
  }
}

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
  const sanitizedBase = {
    ...payload,
    sections: [],
  }

  const singlePage = withDocumentPageInfo(sanitizedBase, {
    page: 1,
    totalPages: 1,
    maxChars,
    strategy: payload?.matches ? 'matches' : 'document',
    totalSections: sanitizedBase.sections.length,
    pageSections: sanitizedBase.sections.length,
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
          payload,
          document,
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
          MIN_SECTION_FRAGMENT_CHARS,
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

function buildDocumentPagePayload({
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

function withDocumentPageInfo(payload, pageInfo) {
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

function buildArrayPaginationPlan({ items, maxChars, initialTotalPages, buildPayload }) {
  let assumedTotalPages = initialTotalPages
  let pages = []

  for (let i = 0; i < MAX_PLAN_ITERATIONS; i++) {
    pages = buildArrayPages({ items, totalPages: assumedTotalPages, maxChars, buildPayload })
    if (pages.length === assumedTotalPages) break
    assumedTotalPages = pages.length
  }

  return { pages, totalPages: pages.length }
}

function buildArrayPages({ items, totalPages, maxChars, buildPayload }) {
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

function buildTextPaginationPlan({ text, maxChars, buildPayload }) {
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

function splitOversizedSection(section, targetChars) {
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

function splitText(text) {
  const paragraphs = text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)
  if (paragraphs.length > 1) return paragraphs

  const lines = text.split('\n').map(part => part.trim()).filter(Boolean)
  if (lines.length > 1) return lines

  return [text.trim()]
}

function groupChunks(chunks, targetChars) {
  const groups = []
  let buffer = []
  let bufferLength = 0

  for (const chunk of chunks) {
    const separator = buffer.length > 0 ? 2 : 0
    if (bufferLength + separator + chunk.length <= targetChars || buffer.length === 0) {
      buffer.push(chunk)
      bufferLength += separator + chunk.length
      continue
    }

    groups.push(buffer.join('\n\n'))
    buffer = [chunk]
    bufferLength = chunk.length
  }

  if (buffer.length > 0) groups.push(buffer.join('\n\n'))
  return groups
}

function splitByCharacterWindow(text, targetChars) {
  const parts = []
  let start = 0
  while (start < text.length) {
    start = skipWhitespace(text, start)
    if (start >= text.length) break
    const end = Math.min(text.length, start + targetChars)
    const slice = sliceTextAtBoundary(text, start, end)
    parts.push(slice.text)
    start = slice.end
  }
  return parts.filter(Boolean)
}

function sliceTextAtBoundary(text, start, end) {
  if (end >= text.length) {
    return {
      text: text.slice(start).trim(),
      end: text.length,
    }
  }

  const slice = text.slice(start, end)
  const boundary = Math.max(
    slice.lastIndexOf('\n\n'),
    slice.lastIndexOf('\n'),
    slice.lastIndexOf(' '),
  )

  if (boundary <= Math.min(24, Math.floor(slice.length / 4))) {
    return {
      text: slice.trim(),
      end,
    }
  }

  return {
    text: slice.slice(0, boundary).trim(),
    end: start + boundary,
  }
}

function excerptAroundMatch(text, index, matchLength, contextChars) {
  const start = Math.max(0, index - contextChars)
  const end = Math.min(text.length, index + matchLength + contextChars)
  const excerpt = text.slice(start, end).trim()
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  return `${prefix}${excerpt}${suffix}`
}

function serializePayload(payload) {
  return JSON.stringify(payload, null, 2)
}

function skipWhitespace(text, start) {
  let index = start
  while (index < text.length && /\s/.test(text[index])) index++
  return index
}

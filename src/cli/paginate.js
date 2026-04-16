/**
 * CLI-specific pagination for markdown content.
 *
 * Unlike MCP pagination (which serializes to JSON and must budget for envelope
 * overhead), this operates directly on the rendered text so every byte of
 * `maxChars` is usable content.
 */

const MIN_MAX_CHARS = 200

/**
 * Split `text` into pages of at most `maxChars` characters each,
 * breaking at paragraph boundaries (\n\n), then line boundaries (\n),
 * then falling back to a hard cut.
 */
function splitPages(text, maxChars) {
  if (text.length <= maxChars) return [text]

  const pages = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      pages.push(remaining)
      break
    }

    let cut = -1

    // Try paragraph break
    const paraSearch = remaining.lastIndexOf('\n\n', maxChars)
    if (paraSearch > 0) {
      cut = paraSearch + 2 // include the double newline in this page
    }

    // Fall back to line break
    if (cut <= 0) {
      const lineSearch = remaining.lastIndexOf('\n', maxChars)
      if (lineSearch > 0) {
        cut = lineSearch + 1
      }
    }

    // Hard cut as last resort
    if (cut <= 0) {
      cut = maxChars
    }

    pages.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut)
  }

  return pages
}

/**
 * Paginate a lookup result for CLI output.
 *
 * @param {object} result  - lookup result with `content` (string) and optionally `metadata`
 * @param {number} maxChars - maximum characters per page
 * @param {number} pageNum  - 1-based page number to return
 * @returns {object} result with `content` replaced by the requested page and `pageInfo` added
 */
export function paginateCliContent(result, maxChars, pageNum = 1) {
  if (maxChars < MIN_MAX_CHARS) {
    return {
      ...result,
      content: `Error: --max-chars must be at least ${MIN_MAX_CHARS}`,
      pageInfo: null,
    }
  }

  const text = result.content
  if (!text || text.length <= maxChars) {
    return result // no pagination needed
  }

  const pages = splitPages(text, maxChars)
  const totalPages = pages.length
  const page = Math.max(1, Math.min(pageNum, totalPages))

  return {
    ...result,
    content: pages[page - 1],
    pageInfo: {
      page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
      strategy: 'text-window',
    },
  }
}

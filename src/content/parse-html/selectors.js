// Lightweight CSS-selector-shaped extraction: finds the first element
// matching `tag`, `.class`, `#id`, or `tag.class` and returns its inner
// HTML with balanced same-tag depth tracking.
//
// Pulled out of content/parse-html.js as part of Phase B.

import {
  escapeRegex,
  getOpenTagRegex,
  getSelectorClassRegex,
  getSelectorIdRegex,
} from './constants.js'

/**
 * Extract the inner HTML of the first element matching a simple selector.
 * Supports: tag, .className, #id, and simple combinations like "tag.class".
 *
 * @param {string} html
 * @param {string} selector
 * @returns {string|null}
 */
export function extractBySelector(html, selector) {
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
    const inner = extractBalancedInner(html, actualTag, match.index)
    if (inner !== null) return inner
  }
  return null
}

/**
 * Extract the inner HTML of the element starting at `startPos` for `tag`.
 * Walks open/close tag boundaries with depth counting so nested same-tag
 * elements don't terminate the match early.
 */
function extractBalancedInner(html, tag, startPos) {
  const lowerHtml = html.toLowerCase()
  const lowerTag = tag.toLowerCase()

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

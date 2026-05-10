// Pure HTML helpers used across the render-html cluster.

import {
  coerceDocument as _coerceDocument,
  coerceSection as _coerceSection,
} from '../coercion.js'

/** Generate a URL-safe slug from heading text. */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Allowlist for href attributes: anchor (#…), root-relative (/…), or
 * http(s)://. Protocol-relative `//…` is rejected because the page may
 * be served over a context (file://, app:// shells) where it would
 * resolve to something unexpected. javascript:/data:/etc are rejected
 * by exclusion.
 */
export function isSafeHref(href) {
  if (!href) return false
  if (href.startsWith('#')) return true
  if (href.startsWith('//')) return false
  if (href.startsWith('/')) return true
  return /^https?:\/\//i.test(href)
}

/**
 * Extract a human-readable name from the last segment of a canonical key.
 * e.g. "swiftui/animation/linear" → "Linear"
 */
export function readableNameFromKey(key) {
  if (!key) return ''
  const segments = key.split('/')
  const last = segments[segments.length - 1]
  return last
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Skip the first heading node if it matches the section heading
 * (prevents "Overview" / "Overview" duplication).
 */
export function skipDuplicateHeading(nodes, sectionHeading) {
  if (!Array.isArray(nodes) || nodes.length === 0) return nodes
  const first = nodes[0]
  if (first.type === 'heading') {
    const headingText = first.text ?? ''
    if (headingText.toLowerCase() === sectionHeading.toLowerCase()) {
      return nodes.slice(1)
    }
  }
  return nodes
}

/**
 * Resolve a reference identifier to an external URL when the corpus key
 * mapping fails. Handles bare https:// URLs, doc:// video references,
 * and other non-documentation references.
 *
 * @returns {{ href: string, title: string } | null}
 */
export function resolveReferenceUrl(identifier) {
  if (!identifier) return null

  // Direct https:// or http:// URL
  if (/^https?:\/\//.test(identifier)) {
    const url = identifier.replace(/\/+$/, '')
    const lastSegment = url.split('/').pop() || url
    const title = lastSegment
      .replace(/[-_]/g, ' ')
      .replace(/\.\w+$/, '')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
    return { href: identifier, title: title || identifier }
  }

  // doc:// video references: doc://com.apple.documentation/videos/play/wwdc2025/281
  const videoMatch = identifier.match(/doc:\/\/[^/]+\/videos\/play\/(\w+)\/(\d+)/)
  if (videoMatch) {
    const event = videoMatch[1].toUpperCase()
    const sessionId = videoMatch[2]
    return {
      href: `https://developer.apple.com/videos/play/${videoMatch[1]}/${sessionId}/`,
      title: `${event} Session ${sessionId}`,
    }
  }

  // doc:// with non-documentation paths
  const docNonDocMatch = identifier.match(/doc:\/\/[^/]+\/(.+)/)
  if (docNonDocMatch) {
    const path = docNonDocMatch[1]
    return {
      href: `https://developer.apple.com/${path}`,
      title: readableNameFromKey(path),
    }
  }

  return null
}

export function coerceDocument(document) {
  return _coerceDocument(document)
}

export function coerceSection(section) {
  return _coerceSection(section, { includeContentJson: true })
}

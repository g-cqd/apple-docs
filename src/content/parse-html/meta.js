// Document-level meta extraction: <title>, <meta name="description">,
// <meta property="og:title">, plus the redirect-stub detector.
//
// Pulled out of content/parse-html.js as part of Phase B.

import { decodeEntities } from './entities.js'
import { htmlToPlainText } from './text-extract.js'

/**
 * Extract document-level meta information from an HTML string.
 *
 * @param {string} html
 * @returns {{ title: string|null, description: string|null, ogTitle: string|null }}
 */
export function extractMetaInfo(html) {
  if (!html) return { title: null, description: null, ogTitle: null }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const rawTitle = titleMatch ? titleMatch[1] : null
  const title = rawTitle ? htmlToPlainText(rawTitle).trim() || null : null

  const descMatch = html.match(
    /<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']*)["'][^>]*>/i,
  ) ?? html.match(
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+name\s*=\s*["']description["'][^>]*>/i,
  )
  const description = descMatch ? decodeEntities(descMatch[1]).trim() || null : null

  const ogMatch = html.match(
    /<meta[^>]+property\s*=\s*["']og:title["'][^>]+content\s*=\s*["']([^"']*)["'][^>]*>/i,
  ) ?? html.match(
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]+property\s*=\s*["']og:title["'][^>]*>/i,
  )
  const ogTitle = ogMatch ? decodeEntities(ogMatch[1]).trim() || null : null

  return { title, description, ogTitle }
}

/**
 * Detect a redirect-stub HTML page (e.g. swift.org legacy URLs that now point
 * at docs.swift.org). Returns the canonical destination URL, or null.
 *
 * Recognizes both the modern Hugo-style stub
 *   <title>Redirecting…</title>
 *   <link rel="canonical" href="…">
 *   <meta http-equiv="refresh" content="0; url=…">
 * and the bare HTTP-server "Document Has Moved" page.
 */
export function detectRedirectStub(html) {
  if (typeof html !== 'string') return null
  // Quick reject: must be small (<2KB) — real content pages are larger.
  if (html.length > 2048) return null
  const isStub = /<title[^>]*>\s*(Redirecting|Document Has Moved|Moved Permanently)/i.test(html)
  if (!isStub) return null
  // Prefer canonical link; fall back to meta-refresh URL; then any first href.
  const canonicalMatch = html.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]+href\s*=\s*["']([^"']+)["']/i)
  if (canonicalMatch) return canonicalMatch[1]
  const refreshMatch = html.match(/<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'][^"']*url\s*=\s*([^"';]+)/i)
  if (refreshMatch) return refreshMatch[1].trim()
  const hrefMatch = html.match(/<a[^>]+href\s*=\s*["']([^"']+)["']/i)
  return hrefMatch ? hrefMatch[1] : null
}

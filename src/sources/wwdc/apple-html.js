// Apple WWDC year-index + per-session HTML scraping.
//
// Pulled out of sources/wwdc.js as part of Phase B. Apple's video pages
// for 2020+ are server-rendered HTML; the parsing here extracts title +
// description + chapters + a coarse transcript by walking the DOM with
// regexes. JSON-LD or render-tree JSON would be cleaner, but Apple
// inlines neither on the public video pages.

import {
  APPLE_BASE,
  APPLE_VIDEOS_INDEX,
  DEFAULT_TIMEOUT,
  USER_AGENT,
} from './constants.js'

/** Fetch the year-level session index from Apple. */
export async function fetchAppleYearIndex(year, rateLimiter) {
  const url = `${APPLE_VIDEOS_INDEX}/wwdc${year}/`
  await rateLimiter.acquire()

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    })
    if (!res.ok) return []
    const html = await res.text()
    return extractSessionIdsFromHtml(html, year)
  } catch {
    return []
  }
}

/**
 * Extract session IDs from a WWDC year-index HTML page.
 * Session links have shape: /videos/play/wwdc{year}/{id}/
 */
function extractSessionIdsFromHtml(html, year) {
  const ids = new Set()
  const re = new RegExp(`/videos/play/wwdc${year}/(\\d+)/?["']`, 'g')
  let match
  while ((match = re.exec(html)) !== null) {
    ids.add(match[1])
  }
  return [...ids]
}

/** Fetch one Apple WWDC session page by scraping. */
export async function fetchAppleSession(year, sessionId, rateLimiter) {
  const url = `${APPLE_BASE}/wwdc${year}/${sessionId}/`
  await rateLimiter.acquire()

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
  })

  if (res.status === 404) {
    throw Object.assign(new Error(`Not found: ${url}`), { status: 404 })
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`)
  }

  const html = await res.text()
  return {
    payload: parseSessionHtml(html, year, sessionId),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  }
}

/** Parse a session HTML page into a structured payload. */
function parseSessionHtml(html, year, sessionId) {
  // Strip noise elements (including site chrome)
  let cleaned = html
  for (const tag of ['script', 'style', 'noscript', 'nav', 'header', 'footer']) {
    let prev
    do {
      prev = cleaned
      cleaned = cleaned.replace(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'gi'), '')
    } while (cleaned !== prev)
  }

  const h1Match = cleaned.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  const title = h1Match ? stripHtmlTags(h1Match[1]) : null

  // Work with content after the <h1> to avoid picking up nav text
  const afterH1 = h1Match ? cleaned.slice(h1Match.index + h1Match[0].length) : cleaned

  const allParagraphs = [...afterH1.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => stripHtmlTags(m[1]))
    .filter(t => t.length > 0)

  // Description: first substantial paragraph (the abstract)
  const description = allParagraphs.find(p => p.length > 30) ?? allParagraphs[0] ?? null
  const descIndex = description ? allParagraphs.indexOf(description) : -1

  const chapters = extractChaptersFromHtml(cleaned)

  // Transcript: paragraphs after the description (skip short UI labels)
  const transcriptParagraphs = descIndex >= 0
    ? allParagraphs.slice(descIndex + 1).filter(p => p.length > 15)
    : []
  const transcript = transcriptParagraphs.join('\n\n') || null

  return {
    title, description, chapters, transcript,
    year, sessionId,
    format: 'html',
  }
}

function stripHtmlTags(html) {
  return decodeHtmlEntities(
    html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
  ).trim()
}

function extractChaptersFromHtml(html) {
  const match = html.match(/<h2[^>]*>\s*Chapters\s*<\/h2>\s*<ul[^>]*>([\s\S]*?)<\/ul>/i)
  if (!match) return []
  return [...match[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map(m => stripHtmlTags(m[1]))
    .filter(Boolean)
}

export function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
}

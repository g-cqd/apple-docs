// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
// Apple WWDC year-index + per-session HTML scraping.
//
// Apple's video pages for 2020+ are server-rendered HTML; the parsing
// here extracts title + description + chapters + a coarse transcript by
// walking the DOM with regexes. JSON-LD or render-tree JSON would be
// cleaner, but Apple inlines neither on the public video pages.

import { HttpError } from '../../lib/errors.js'
import { APPLE_BASE, APPLE_VIDEOS_INDEX, DEFAULT_TIMEOUT, USER_AGENT } from './constants.js'

/**
 * Fetch the year-level session index from Apple. Returns session IDs
 * plus a sessionId -> track map; the per-session play pages never name
 * their topic, so the index is the only scrape point for tracks.
 */
export async function fetchAppleYearIndex(year, rateLimiter) {
  const url = `${APPLE_VIDEOS_INDEX}/wwdc${year}/`
  try {
    await rateLimiter.acquire()
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    })
    if (!res.ok) return emptyYearIndex()
    const html = await res.text()
    return {
      sessionIds: extractSessionIdsFromHtml(html, year),
      tracksBySession: extractSessionTracksFromHtml(html, year),
    }
  } catch {
    return emptyYearIndex()
  }
}

function emptyYearIndex() {
  return { sessionIds: [], tracksBySession: new Map() }
}

/**
 * Extract session IDs from a WWDC year-index HTML page.
 * Session links have shape: /videos/play/wwdc{year}/{id}/
 */
function extractSessionIdsFromHtml(html, year) {
  const ids = new Set()
  const re = new RegExp(`/videos/play/wwdc${year}/(\\d+)/?["']`, 'g')
  for (const match of html.matchAll(re)) {
    ids.add(match[1])
  }
  return [...ids]
}

/**
 * Extract sessionId -> track from a year-index page. Each session card
 * is an `<a href="/videos/play/wwdc{year}/{id}/" class="vc-card" ...>`
 * whose body carries the human-readable, pipe-separated topic names in
 * a `data-filter-topics` attribute.
 */
function extractSessionTracksFromHtml(html, year) {
  const tracks = new Map()
  const anchorRe = new RegExp(`<a\\s[^>]*href="/videos/play/wwdc${year}/(\\d+)/?"[^>]*>`, 'gi')
  const anchors = [...html.matchAll(anchorRe)]
  for (const [i, anchor] of anchors.entries()) {
    const sessionId = anchor[1]
    if (tracks.has(sessionId)) continue
    const card = html.slice(anchor.index, anchors[i + 1]?.index ?? html.length)
    const topics = card.match(/data-filter-topics="([^"]*)"/i)
    const track = topics ? decodeHtmlEntities(topics[1]).replace(/\s+/g, ' ').trim() : ''
    if (track) tracks.set(sessionId, track)
  }
  return tracks
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
    throw new HttpError(res.status, url, `HTTP ${res.status} fetching ${url}`)
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

  const allParagraphs = [...afterH1.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripHtmlTags(m[1])).filter((t) => t.length > 0)

  // Description: first substantial paragraph (the abstract)
  const description = allParagraphs.find((p) => p.length > 30) ?? allParagraphs[0] ?? null
  const descIndex = description ? allParagraphs.indexOf(description) : -1

  const chapters = extractChaptersFromHtml(cleaned)

  // Transcript: paragraphs after the description (skip short UI labels)
  const transcriptParagraphs = descIndex >= 0 ? allParagraphs.slice(descIndex + 1).filter((p) => p.length > 15) : []
  const transcript = transcriptParagraphs.join('\n\n') || null

  return {
    title,
    description,
    chapters,
    transcript,
    year,
    sessionId,
    format: 'html',
  }
}

function stripHtmlTags(html) {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim()
}

function extractChaptersFromHtml(html) {
  const match = html.match(/<h2[^>]*>\s*Chapters\s*<\/h2>\s*<ul[^>]*>([\s\S]*?)<\/ul>/i)
  if (!match) return []
  return [...match[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripHtmlTags(m[1])).filter(Boolean)
}

export function decodeHtmlEntities(value) {
  // Decode &amp; LAST so an input like `&amp;lt;` (a literal `&lt;`
  // string that was further escaped) round-trips correctly. Otherwise
  // we'd produce `<` instead of `&lt;`. Resolves CodeQL
  // `js/double-escaping`.
  return String(value ?? '')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

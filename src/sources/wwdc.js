import { checkRawGitHub, fetchGitHubTree, fetchRawGitHub } from '../lib/github.js'
import { checkHtmlPage } from '../apple/api.js'
import { SourceAdapter } from './base.js'

const ROOT_SLUG = 'wwdc'
const APPLE_VIDEOS_INDEX = 'https://developer.apple.com/videos'
const APPLE_BASE = 'https://developer.apple.com/videos/play'
const ASCIIWWDC_OWNER = 'ASCIIwwdc'
const ASCIIWWDC_REPO = 'wwdc-session-transcripts'
const ASCIIWWDC_BRANCH = 'master'
const ASCIIWWDC_LANGUAGE = 'en'
const USER_AGENT = 'apple-docs/2.0'
const DEFAULT_TIMEOUT = 30_000

/** Years served by Apple's WWDC videos pages (HTML scraping). */
const APPLE_YEARS = Array.from({ length: new Date().getFullYear() - 2020 + 1 }, (_, i) => 2020 + i)

/** Years served by ASCIIwwdc community transcripts. */
const ASCIIWWDC_YEAR_MIN = 1997
const ASCIIWWDC_YEAR_MAX = 2019
const VTT_TIMESTAMP_RE = /^(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}\.\d{3}(?:\s+.*)?$/

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/**
 * Parse a WWDC key like `wwdc/wwdc2024-10001` into its components.
 * Returns null if the key does not match the expected shape.
 *
 * @param {string} key
 * @returns {{ year: number, sessionId: string } | null}
 */
export function parseWwdcKey(key) {
  const match = key.match(/^wwdc\/wwdc(\d{4})-(\d+)$/)
  if (!match) return null
  return { year: Number.parseInt(match[1], 10), sessionId: match[2] }
}

/**
 * Build the canonical key for a WWDC session.
 *
 * @param {number} year
 * @param {string|number} sessionId
 * @returns {string}
 */
function buildKey(year, sessionId) {
  return `${ROOT_SLUG}/wwdc${year}-${sessionId}`
}

function buildAsciiwwdcPath(year, sessionId) {
  return `${ASCIIWWDC_LANGUAGE}/${year}/${sessionId}.vtt`
}

// ---------------------------------------------------------------------------
// Apple HTML scraping helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the year-level session index from Apple's WWDC videos page.
 * Scrapes the HTML listing to extract session IDs from link hrefs.
 *
 * @param {number} year
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @returns {Promise<string[]>}
 */
async function fetchAppleYearIndex(year, rateLimiter) {
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
 * Extract session IDs from an Apple WWDC year-index HTML page.
 * Session links have the shape: /videos/play/wwdc{year}/{id}/
 *
 * @param {string} html
 * @param {number} year
 * @returns {string[]}
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

/**
 * Fetch a per-session Apple WWDC page by scraping the HTML.
 *
 * @param {number} year
 * @param {string} sessionId
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @returns {Promise<{ payload: object, etag: string|null, lastModified: string|null }>}
 */
async function fetchAppleSession(year, sessionId, rateLimiter) {
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

// ---------------------------------------------------------------------------
// HTML session page parsing
// ---------------------------------------------------------------------------

/**
 * Parse an Apple WWDC session HTML page into a structured payload.
 *
 * @param {string} html - Raw HTML of the session page.
 * @param {number} year
 * @param {string} sessionId
 * @returns {object}
 */
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

  // Title from <h1>
  const h1Match = cleaned.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  const title = h1Match ? stripHtmlTags(h1Match[1]) : null

  // Work with content after the <h1> to avoid picking up nav text
  const afterH1 = h1Match ? cleaned.slice(h1Match.index + h1Match[0].length) : cleaned

  // All paragraphs after the heading
  const allParagraphs = [...afterH1.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => stripHtmlTags(m[1]))
    .filter(t => t.length > 0)

  // Description: first substantial paragraph (the abstract)
  const description = allParagraphs.find(p => p.length > 30) ?? allParagraphs[0] ?? null
  const descIndex = description ? allParagraphs.indexOf(description) : -1

  // Chapters: look for "Chapters" heading followed by a list
  const chapters = extractChaptersFromHtml(cleaned)

  // Transcript: paragraphs after the description (skip short UI labels)
  const transcriptParagraphs = descIndex >= 0
    ? allParagraphs.slice(descIndex + 1).filter(p => p.length > 15)
    : []
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

/**
 * Strip all HTML tags from a string and decode entities.
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtmlTags(html) {
  return decodeHtmlEntities(
    html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
  ).trim()
}

/**
 * Extract chapter titles from a session page's "Chapters" section.
 *
 * @param {string} html
 * @returns {string[]}
 */
function extractChaptersFromHtml(html) {
  const match = html.match(/<h2[^>]*>\s*Chapters\s*<\/h2>\s*<ul[^>]*>([\s\S]*?)<\/ul>/i)
  if (!match) return []
  return [...match[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map(m => stripHtmlTags(m[1]))
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Transcript extraction helpers
// ---------------------------------------------------------------------------

/**
 * Walk the Apple JSON structure to find the first transcript-like text block.
 * Apple's session JSON is a DocC-style render tree with inline content.
 *
 * @param {object} json
 * @returns {string|null}
 */
function extractAppleTranscript(json) {
  // Look for a "transcript" key at any depth (common in some years)
  const candidate = deepFind(json, 'transcript')
  if (typeof candidate === 'string' && candidate.length > 0) {
    return { text: candidate, nodes: null }
  }

  // Look for primaryContentSections or sections with prose content
  const sections = json?.primaryContentSections ?? json?.sections ?? []
  const texts = []
  const allNodes = []
  for (const section of Array.isArray(sections) ? sections : []) {
    if (section?.kind === 'content' || section?.kind === 'transcript') {
      const contentNodes = section?.content ?? []
      texts.push(...collectInlineText(contentNodes))
      allNodes.push(...contentNodes)
    }
  }
  if (texts.length === 0) return { text: null, nodes: null }
  return { text: texts.join('\n\n'), nodes: allNodes.length > 0 ? allNodes : null }
}

/**
 * Recursively search an object for the first value at a given key.
 *
 * @param {unknown} obj
 * @param {string} key
 * @param {number} maxDepth
 * @returns {unknown}
 */
function deepFind(obj, key, maxDepth = 6) {
  if (maxDepth <= 0 || obj == null || typeof obj !== 'object') return undefined
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key]
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key, maxDepth - 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Collect plain text strings from a DocC render-tree content array.
 * Handles paragraph, codeListing, codeVoice, and other inline nodes.
 *
 * @param {unknown[]} content
 * @returns {string[]}
 */
function collectInlineText(content) {
  const texts = []
  for (const node of Array.isArray(content) ? content : []) {
    if (node?.type === 'text' && typeof node.text === 'string') {
      texts.push(node.text)
    } else if (node?.type === 'codeVoice' && typeof node.code === 'string') {
      texts.push(node.code)
    } else if (node?.type === 'codeListing') {
      texts.push((node.code ?? []).join('\n'))
    } else if (node?.type === 'paragraph') {
      texts.push(...collectInlineText(node.inlineContent ?? []))
    } else if (Array.isArray(node?.inlineContent)) {
      texts.push(...collectInlineText(node.inlineContent))
    } else if (Array.isArray(node?.content)) {
      texts.push(...collectInlineText(node.content))
    }
  }
  return texts
}

/**
 * Extract the abstract/description from an Apple session JSON payload.
 *
 * @param {object} json
 * @returns {string|null}
 */
function extractAppleDescription(json) {
  if (typeof json?.description === 'string' && json.description.length > 0) {
    return json.description
  }

  // Look inside abstract sections (DocC shape)
  const abstractSection = (json?.primaryContentSections ?? []).find(
    s => s?.kind === 'abstract',
  )
  if (abstractSection) {
    const parts = collectInlineText(abstractSection?.content ?? [])
    if (parts.length > 0) return parts.join(' ')
  }

  // metadata.description
  if (typeof json?.metadata?.description === 'string') {
    return json.metadata.description
  }

  return null
}

/**
 * Extract the title from an Apple session JSON payload.
 *
 * @param {object} json
 * @param {number} year
 * @param {string} sessionId
 * @returns {string}
 */
function extractAppleTitle(json, year, sessionId) {
  const candidate =
    json?.title ??
    json?.metadata?.title ??
    deepFind(json, 'title')
  if (typeof candidate === 'string' && candidate.length > 0) return candidate
  return `WWDC${year} Session ${sessionId}`
}

// ---------------------------------------------------------------------------
// ASCIIwwdc parsing helpers
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable title from a session's text content and file name.
 * ASCIIwwdc files occasionally start with a heading line.
 *
 * @param {string} text
 * @param {number} year
 * @param {string} sessionId
 * @returns {string}
 */
function extractAsciiwwdcTitle(text, year, sessionId) {
  if (String(text).includes('WEBVTT') || VTT_TIMESTAMP_RE.test(String(text).split('\n')[0]?.trim() ?? '')) {
    return `WWDC${year} Session ${sessionId}`
  }

  const firstLine = text.split('\n').find(line => line.trim().length > 0)
  if (firstLine && !/^\[?\d{2}:\d{2}/.test(firstLine.trim())) {
    const candidate = firstLine.trim()
    if (candidate.length > 0 && candidate.length < 200) return candidate
  }
  return `WWDC${year} Session ${sessionId}`
}

function decodeHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
}

function normalizeAsciiwwdcTranscript(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  const cleaned = []
  for (const rawLine of lines) {
    const line = decodeHtmlEntities(rawLine).replace(/<[^>]+>/g, '').trim()
    if (!line) continue
    if (line === 'WEBVTT') continue
    if (/^\d+$/.test(line)) continue
    if (line.startsWith('NOTE')) continue
    if (VTT_TIMESTAMP_RE.test(line)) continue
    if (cleaned[cleaned.length - 1] === line) continue
    cleaned.push(line)
  }

  return cleaned.join('\n')
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class WwdcAdapter extends SourceAdapter {
  static type = 'wwdc'
  static displayName = 'WWDC Session Transcripts'
  static syncMode = 'flat'

  // -------------------------------------------------------------------------
  // discover
  // -------------------------------------------------------------------------

  async discover(ctx) {
    if (ctx.db && !ctx.db.getRootBySlug(ROOT_SLUG)) {
      ctx.db.upsertRoot(ROOT_SLUG, 'WWDC Session Transcripts', 'collection', ROOT_SLUG)
    }
    const root = ctx.db?.getRootBySlug(ROOT_SLUG) ?? null

    const [appleKeys, asciiwwdcKeys] = await Promise.all([
      this.#discoverAppleKeys(ctx),
      this.#discoverAsciiwwdcKeys(ctx),
    ])

    // Merge, deduplicate by key
    const seen = new Set()
    const keys = []
    for (const key of [...appleKeys, ...asciiwwdcKeys]) {
      if (!seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
    }

    return this.validateDiscoveryResult({
      keys,
      roots: root ? [root] : undefined,
    })
  }

  /**
   * Discover Apple session keys for years 2020+.
   * Failed year fetches are silently skipped.
   *
   * @param {object} ctx
   * @returns {Promise<string[]>}
   */
  async #discoverAppleKeys(ctx) {
    const keys = []
    await Promise.all(
      APPLE_YEARS.map(async (year) => {
        const sessionIds = await fetchAppleYearIndex(year, ctx.rateLimiter)
        for (const id of sessionIds) {
          keys.push(buildKey(year, id))
        }
      }),
    )
    return keys
  }

  /**
   * Discover ASCIIwwdc session keys for years 2012-2019.
   *
   * @param {object} ctx
   * @returns {Promise<string[]>}
   */
  async #discoverAsciiwwdcKeys(ctx) {
    const tree = await fetchGitHubTree(
      ASCIIWWDC_OWNER,
      ASCIIWWDC_REPO,
      ASCIIWWDC_BRANCH,
      ctx.rateLimiter,
    )

    const keys = []
    for (const entry of tree) {
      if (entry.type !== 'blob' || !entry.path.endsWith('.vtt')) continue
      // Expected path shape: en/<year>/<sessionId>.vtt  (e.g. en/2019/234.vtt)
      const match = entry.path.match(new RegExp(`^${ASCIIWWDC_LANGUAGE}/(\\d{4})/(\\d+)\\.vtt$`))
      if (!match) continue
      const year = Number.parseInt(match[1], 10)
      if (year < ASCIIWWDC_YEAR_MIN || year > ASCIIWWDC_YEAR_MAX) continue
      keys.push(buildKey(year, match[2]))
    }
    return keys
  }

  // -------------------------------------------------------------------------
  // fetch
  // -------------------------------------------------------------------------

  async fetch(key, ctx) {
    const parsed = parseWwdcKey(key)
    if (!parsed) throw new Error(`Invalid WWDC key: ${key}`)

    const { year, sessionId } = parsed

    if (year >= 2020) {
      const { payload, etag, lastModified } = await fetchAppleSession(year, sessionId, ctx.rateLimiter)
      return this.validateFetchResult({
        key,
        payload,
        etag,
        lastModified,
      })
    }

    // Pre-2020: fetch from ASCIIwwdc
    const { text, etag, lastModified } = await fetchRawGitHub(
      ASCIIWWDC_OWNER,
      ASCIIWWDC_REPO,
      ASCIIWWDC_BRANCH,
      buildAsciiwwdcPath(year, sessionId),
      ctx.rateLimiter,
    )
    return this.validateFetchResult({
      key,
      payload: { transcript: text, year, sessionId, format: 'vtt' },
      etag,
      lastModified,
    })
  }

  // -------------------------------------------------------------------------
  // check
  // -------------------------------------------------------------------------

  async check(key, previousState, ctx) {
    const parsed = parseWwdcKey(key)
    if (!parsed) {
      return this.validateCheckResult({
        status: 'error',
        changed: false,
        newState: previousState ?? {},
      })
    }

    const { year, sessionId } = parsed

    if (year >= 2020) {
      const url = `${APPLE_BASE}/wwdc${year}/${sessionId}/`
      const result = await checkHtmlPage(url, previousState?.etag ?? null, ctx.rateLimiter)
      return this.validateCheckResult({
        status: result.status,
        changed: result.status === 'modified',
        deleted: result.status === 'deleted',
        newState: { etag: result.etag ?? previousState?.etag ?? null },
      })
    }

    // Pre-2020: check ASCIIwwdc
    const result = await checkRawGitHub(
      ASCIIWWDC_OWNER,
      ASCIIWWDC_REPO,
      ASCIIWWDC_BRANCH,
      buildAsciiwwdcPath(year, sessionId),
      previousState?.etag ?? null,
      ctx.rateLimiter,
    )
    return this.validateCheckResult({
      status: result.status,
      changed: result.status === 'modified',
      deleted: result.status === 'deleted',
      newState: { etag: result.etag ?? previousState?.etag ?? null },
    })
  }

  // -------------------------------------------------------------------------
  // normalize
  // -------------------------------------------------------------------------

  normalize(key, rawPayload) {
    const parsed = parseWwdcKey(key)
    if (!parsed) throw new Error(`Invalid WWDC key: ${key}`)
    const { year, sessionId } = parsed

    if (year >= 2020) {
      return this.validateNormalizeResult(
        this.#normalizeApple(key, rawPayload, year, sessionId),
      )
    }
    return this.validateNormalizeResult(
      this.#normalizeAsciiwwdc(key, rawPayload, year, sessionId),
    )
  }

  /**
   * Normalize an Apple JSON session payload (2020+).
   *
   * @param {string} key
   * @param {object} json
   * @param {number} year
   * @param {string} sessionId
   * @returns {import('./base.js').NormalizeResult}
   */
  #normalizeApple(key, json, year, sessionId) {
    const title = extractAppleTitle(json, year, sessionId)
    const description = extractAppleDescription(json)
    const { text: transcript, nodes: transcriptNodes } = extractAppleTranscript(json)
    const url = `${APPLE_BASE}/wwdc${year}/${sessionId}/`

    const document = {
      sourceType: WwdcAdapter.type,
      key,
      title,
      kind: 'wwdc-session',
      role: 'article',
      roleHeading: null,
      framework: ROOT_SLUG,
      url,
      language: null,
      abstractText: description ?? null,
      declarationText: null,
      platformsJson: null,
      minIos: null,
      minMacos: null,
      minWatchos: null,
      minTvos: null,
      minVisionos: null,
      isDeprecated: false,
      isBeta: false,
      isReleaseNotes: false,
      urlDepth: key.split('/').length - 1,
      headings: null,
      sourceMetadata: JSON.stringify({ year, sessionId, source: 'apple' }),
    }

    const sections = []

    if (description) {
      sections.push({
        sectionKind: 'abstract',
        heading: null,
        contentText: description,
      })
    }

    if (Array.isArray(json?.chapters) && json.chapters.length > 0) {
      sections.push({
        sectionKind: 'content',
        heading: 'Chapters',
        contentText: json.chapters.join('\n'),
      })
    }

    if (transcript) {
      sections.push({
        sectionKind: transcriptNodes ? 'discussion' : 'content',
        heading: 'Transcript',
        contentText: transcript,
        contentJson: transcriptNodes ? JSON.stringify(transcriptNodes) : null,
      })
    }

    return { document, sections, relationships: [] }
  }

  /**
   * Normalize an ASCIIwwdc plain-text payload (pre-2020).
   *
   * @param {string} key
   * @param {{ transcript: string, year: number, sessionId: string }} payload
   * @param {number} year
   * @param {string} sessionId
   * @returns {import('./base.js').NormalizeResult}
   */
  #normalizeAsciiwwdc(key, payload, year, sessionId) {
    const rawText = typeof payload?.transcript === 'string'
      ? payload.transcript
      : typeof payload === 'string'
        ? payload
        : ''
    const text = normalizeAsciiwwdcTranscript(rawText)

    const title = extractAsciiwwdcTitle(rawText, year, sessionId)
    const url = `${APPLE_BASE}/wwdc${year}/${sessionId}/`

    const document = {
      sourceType: WwdcAdapter.type,
      key,
      title,
      kind: 'wwdc-session',
      role: 'article',
      roleHeading: null,
      framework: ROOT_SLUG,
      url,
      language: null,
      abstractText: null,
      declarationText: null,
      platformsJson: null,
      minIos: null,
      minMacos: null,
      minWatchos: null,
      minTvos: null,
      minVisionos: null,
      isDeprecated: false,
      isBeta: false,
      isReleaseNotes: false,
      urlDepth: key.split('/').length - 1,
      headings: null,
      sourceMetadata: JSON.stringify({ year, sessionId, source: 'asciiwwdc' }),
    }

    const sections = [
      {
        sectionKind: 'content',
        heading: 'Transcript',
        contentText: text,
      },
    ]

    return { document, sections, relationships: [] }
  }

  renderHints() {
    return { showTimestamps: true, showYear: true }
  }
}

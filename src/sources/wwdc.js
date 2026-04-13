import { checkRawGitHub, fetchGitHubTree, fetchRawGitHub } from '../lib/github.js'
import { checkHtmlPage } from '../apple/api.js'
import { SourceAdapter } from './base.js'

const ROOT_SLUG = 'wwdc'
const APPLE_VIDEOS_BASE = 'https://developer.apple.com/tutorials/data/content/videos'
const APPLE_BASE = 'https://developer.apple.com/videos/play'
const ASCIIWWDC_OWNER = 'ASCIIwwdc'
const ASCIIWWDC_REPO = 'wwdc-session-transcripts'
const ASCIIWWDC_BRANCH = 'master'
const ASCIIWWDC_LANGUAGE = 'en'
const USER_AGENT = 'apple-docs/2.0'
const DEFAULT_TIMEOUT = 30_000

/** Years served by Apple's structured JSON API. */
const APPLE_YEARS = [2020, 2021, 2022, 2023, 2024, 2025]

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
  return { year: parseInt(match[1], 10), sessionId: match[2] }
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
// Apple JSON fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the year-level session index from Apple's video data API.
 * Returns an array of session ID strings, or an empty array on failure.
 *
 * @param {number} year
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @returns {Promise<string[]>}
 */
async function fetchAppleYearIndex(year, rateLimiter) {
  const url = `${APPLE_VIDEOS_BASE}/wwdc${year}.json`
  await rateLimiter.acquire()

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    })
    if (!res.ok) return []
    const data = await res.json()
    return extractSessionIds(data)
  } catch {
    return []
  }
}

/**
 * Extract session IDs from the Apple year-index JSON.
 * The exact shape varies by year, but common patterns are checked.
 *
 * @param {object} data
 * @returns {string[]}
 */
function extractSessionIds(data) {
  const ids = new Set()

  // Pattern: { sections: [{ videos: [{ id: '10001' }] }] }
  if (Array.isArray(data?.sections)) {
    for (const section of data.sections) {
      for (const video of section?.videos ?? []) {
        if (video?.id) ids.add(String(video.id))
      }
    }
  }

  // Pattern: { videos: [{ id: '10001' }] }
  if (Array.isArray(data?.videos)) {
    for (const video of data.videos) {
      if (video?.id) ids.add(String(video.id))
    }
  }

  // Pattern: { sessions: [{ id: '10001' }] } or flat array of sessions
  const sessions = Array.isArray(data?.sessions)
    ? data.sessions
    : Array.isArray(data)
      ? data
      : []
  for (const session of sessions) {
    if (session?.id) ids.add(String(session.id))
  }

  return [...ids]
}

/**
 * Fetch the per-session Apple JSON payload.
 *
 * @param {number} year
 * @param {string} sessionId
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @returns {Promise<{ json: object, etag: string|null, lastModified: string|null }>}
 */
async function fetchAppleSession(year, sessionId, rateLimiter) {
  const url = `${APPLE_VIDEOS_BASE}/play/wwdc${year}/${sessionId}.json`
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

  return {
    json: await res.json(),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  }
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
  if (typeof candidate === 'string' && candidate.length > 0) return candidate

  // Look for primaryContentSections or sections with prose content
  const sections = json?.primaryContentSections ?? json?.sections ?? []
  const texts = []
  for (const section of Array.isArray(sections) ? sections : []) {
    if (section?.kind === 'content' || section?.kind === 'transcript') {
      texts.push(...collectInlineText(section?.content ?? []))
    }
  }
  return texts.length > 0 ? texts.join('\n\n') : null
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
 *
 * @param {unknown[]} content
 * @returns {string[]}
 */
function collectInlineText(content) {
  const texts = []
  for (const node of Array.isArray(content) ? content : []) {
    if (node?.type === 'text' && typeof node.text === 'string') {
      texts.push(node.text)
    } else if (node?.type === 'paragraph') {
      texts.push(...collectInlineText(node.inlineContent ?? []))
    } else if (Array.isArray(node?.inlineContent)) {
      texts.push(...collectInlineText(node.inlineContent))
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
      const year = parseInt(match[1], 10)
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
      const { json, etag, lastModified } = await fetchAppleSession(year, sessionId, ctx.rateLimiter)
      return this.validateFetchResult({
        key,
        payload: json,
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
      const url = `${APPLE_VIDEOS_BASE}/play/wwdc${year}/${sessionId}.json`
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
    const transcript = extractAppleTranscript(json)
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
        kind: 'abstract',
        heading: null,
        content: description,
      })
    }

    if (transcript) {
      sections.push({
        kind: 'content',
        heading: 'Transcript',
        content: transcript,
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
        kind: 'content',
        heading: 'Transcript',
        content: text,
      },
    ]

    return { document, sections, relationships: [] }
  }
}

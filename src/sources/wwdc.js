// WWDC source adapter. Two corpora behind one adapter:
//   - Apple's developer.apple.com video pages (2020+, HTML scrape)
//   - ASCIIwwdc community transcripts (1997-2019, GitHub raw .vtt files)
//
// Phase B decomposition: keys + constants in wwdc/constants.js, Apple
// HTML scraping in wwdc/apple-html.js, transcript / description / title
// extraction in wwdc/transcript.js. This module is the adapter shell.

import { checkRawGitHub, fetchGitHubTree, fetchRawGitHub } from '../lib/github.js'
import { checkHtmlPage } from '../apple/api.js'
import { SourceAdapter } from './base.js'
import {
  APPLE_BASE,
  APPLE_YEARS,
  ASCIIWWDC_BRANCH,
  ASCIIWWDC_LANGUAGE,
  ASCIIWWDC_OWNER,
  ASCIIWWDC_REPO,
  ASCIIWWDC_YEAR_MAX,
  ASCIIWWDC_YEAR_MIN,
  ROOT_SLUG,
  buildAsciiwwdcPath,
  buildKey,
  parseWwdcKey,
} from './wwdc/constants.js'
import { fetchAppleSession, fetchAppleYearIndex } from './wwdc/apple-html.js'
import {
  extractAppleDescription,
  extractAppleTitle,
  extractAppleTranscript,
  extractAsciiwwdcTitle,
  normalizeAsciiwwdcTranscript,
} from './wwdc/transcript.js'

export { parseWwdcKey }

export class WwdcAdapter extends SourceAdapter {
  static type = 'wwdc'
  static displayName = 'WWDC Session Transcripts'
  static syncMode = 'flat'

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

  /** Discover Apple session keys for years 2020+. Failed years skipped silently. */
  async #discoverAppleKeys(ctx) {
    const keys = []
    await Promise.all(
      APPLE_YEARS.map(async (year) => {
        const sessionIds = await fetchAppleYearIndex(year, ctx.rateLimiter)
        for (const id of sessionIds) keys.push(buildKey(year, id))
      }),
    )
    return keys
  }

  /** Discover ASCIIwwdc session keys for years 1997-2019. */
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
      // en/<year>/<sessionId>.vtt
      const match = entry.path.match(new RegExp(`^${ASCIIWWDC_LANGUAGE}/(\\d{4})/(\\d+)\\.vtt$`))
      if (!match) continue
      const year = Number.parseInt(match[1], 10)
      if (year < ASCIIWWDC_YEAR_MIN || year > ASCIIWWDC_YEAR_MAX) continue
      keys.push(buildKey(year, match[2]))
    }
    return keys
  }

  async fetch(key, ctx) {
    const parsed = parseWwdcKey(key)
    if (!parsed) throw new Error(`Invalid WWDC key: ${key}`)

    const { year, sessionId } = parsed

    if (year >= 2020) {
      const { payload, etag, lastModified } = await fetchAppleSession(year, sessionId, ctx.rateLimiter)
      return this.validateFetchResult({ key, payload, etag, lastModified })
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

  normalize(key, rawPayload) {
    const parsed = parseWwdcKey(key)
    if (!parsed) throw new Error(`Invalid WWDC key: ${key}`)
    const { year, sessionId } = parsed

    if (year >= 2020) {
      return this.validateNormalizeResult(this.#normalizeApple(key, rawPayload, year, sessionId))
    }
    return this.validateNormalizeResult(this.#normalizeAsciiwwdc(key, rawPayload, year, sessionId))
  }

  #normalizeApple(key, json, year, sessionId) {
    const title = extractAppleTitle(json, year, sessionId)
    const description = extractAppleDescription(json)
    const { text: transcript, nodes: transcriptNodes } = extractAppleTranscript(json)
    const url = `${APPLE_BASE}/wwdc${year}/${sessionId}/`

    const document = {
      sourceType: WwdcAdapter.type,
      key, title,
      kind: 'wwdc-session',
      role: 'article',
      roleHeading: null,
      framework: ROOT_SLUG,
      url,
      language: null,
      abstractText: description ?? null,
      declarationText: null,
      platformsJson: null,
      minIos: null, minMacos: null, minWatchos: null, minTvos: null, minVisionos: null,
      isDeprecated: false, isBeta: false, isReleaseNotes: false,
      urlDepth: key.split('/').length - 1,
      headings: null,
      sourceMetadata: JSON.stringify({ year, sessionId, source: 'apple' }),
    }

    const sections = []
    if (description) {
      sections.push({ sectionKind: 'abstract', heading: null, contentText: description })
    }
    if (Array.isArray(json?.chapters) && json.chapters.length > 0) {
      sections.push({ sectionKind: 'content', heading: 'Chapters', contentText: json.chapters.join('\n') })
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

  #normalizeAsciiwwdc(key, payload, year, sessionId) {
    const rawText = typeof payload?.transcript === 'string'
      ? payload.transcript
      : typeof payload === 'string' ? payload : ''
    const text = normalizeAsciiwwdcTranscript(rawText)

    const title = extractAsciiwwdcTitle(rawText, year, sessionId)
    const url = `${APPLE_BASE}/wwdc${year}/${sessionId}/`

    const document = {
      sourceType: WwdcAdapter.type,
      key, title,
      kind: 'wwdc-session',
      role: 'article',
      roleHeading: null,
      framework: ROOT_SLUG,
      url,
      language: null,
      abstractText: null,
      declarationText: null,
      platformsJson: null,
      minIos: null, minMacos: null, minWatchos: null, minTvos: null, minVisionos: null,
      isDeprecated: false, isBeta: false, isReleaseNotes: false,
      urlDepth: key.split('/').length - 1,
      headings: null,
      sourceMetadata: JSON.stringify({ year, sessionId, source: 'asciiwwdc' }),
    }

    const sections = [
      { sectionKind: 'content', heading: 'Transcript', contentText: text },
    ]

    return { document, sections, relationships: [] }
  }

  renderHints() {
    return { showTimestamps: true, showYear: true }
  }
}

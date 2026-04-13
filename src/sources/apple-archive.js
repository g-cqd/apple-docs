import { fetchHtmlPage } from '../apple/api.js'
import { parseHtmlToNormalized } from '../content/parse-html.js'
import { SourceAdapter } from './base.js'

const ROOT_SLUG = 'apple-archive'
const ARCHIVE_BASE = 'https://developer.apple.com/library/archive'
const ARCHIVE_LIBRARY_URL = `${ARCHIVE_BASE}/navigation/library.json`
const GUIDE_RESOURCE_TYPE_KEY = '3'
const ARCHIVE_SUPPORTED_FORMATS = new Set(['html', 'htm', 'pdf'])
const KNOWN_MISSING_ARCHIVE_PATHS = new Set([
  'documentation/Hardware/hardware2.html',
  'documentation/Hardware/legacy/legacy.html',
  'documentation/Carbon/Conceptual/DesktopIcons/ch13.html',
  'documentation/Carbon/Conceptual/DragMgrProgrammersGuide/DragMgrProgrammersGuide.pdf',
  'documentation/General/Conceptual/Apple_News_Format_Ref/index.html',
  'documentation/General/Conceptual/News_API_Ref/index.html',
  'documentation/Performance/Conceptual/Mac_OSX_Numerics/Mac_OSX_Numerics.pdf',
  'documentation/General/Conceptual/AppStoreSearchAdsAPIReference/index.html',
  'documentation/QuickTime/whatsnew.htm',
])
const USER_AGENT = 'apple-docs/2.0'
const DEFAULT_TIMEOUT = 30_000

/**
 * Apple serves the archive catalog as a JS-object literal, not strict JSON.
 * We only evaluate Apple's own manifest response here.
 *
 * @param {string} rawText
 * @returns {object}
 */
function parseArchiveLibrary(rawText) {
  // Try strict JSON first
  try { return JSON.parse(rawText) } catch {}
  // Apple serves JS object literals — sanitize to valid JSON before parsing:
  // 1. Strip wrapping parens: ({...}) → {...}
  // 2. Remove trailing commas before } or ]
  // 3. Quote unquoted property keys
  let sanitized = rawText.trim()
  if (sanitized.startsWith('(') && sanitized.endsWith(')')) {
    sanitized = sanitized.slice(1, -1)
  }
  sanitized = sanitized
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":')
  return JSON.parse(sanitized)
}

/**
 * Convert a relative archive URL from library.json into a path suitable for
 * key generation and fetching.
 *
 * @param {string} relativeUrl
 * @returns {string}
 */
function normalizeArchiveRelativeUrl(relativeUrl) {
  return relativeUrl.replace(/^\.\.\//, '').replace(/#.*$/, '')
}

/**
 * Derive the canonical key for an archive guide path.
 * Strips the terminal HTML filename while preserving the guide directory.
 *
 * @param {string} guidePath
 * @returns {string}
 */
function pathToKey(guidePath) {
  const withoutFilename = guidePath.replace(/\/[^/]+\.(?:html|htm)$/i, '')
  return `${ROOT_SLUG}/${withoutFilename}`
}

/**
 * Best-effort fallback URL reconstruction if the catalog isn't cached.
 *
 * @param {string} key
 * @returns {string}
 */
function keyToFallbackUrl(key) {
  const pathPrefix = key.replace(`${ROOT_SLUG}/`, '')
  return `${ARCHIVE_BASE}/${pathPrefix}/index.html`
}

/**
 * Decode the small set of entities commonly present in the archive manifest.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function decodeHtmlEntities(value) {
  if (typeof value !== 'string') return null
  return value
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function getArchiveFormat(relativeUrl) {
  const match = relativeUrl.match(/\.([a-z0-9]+)$/i)
  return (match?.[1] ?? 'html').toLowerCase()
}

async function fetchArchivePdfMetadata(url, rateLimiter) {
  await rateLimiter.acquire()

  const res = await fetch(url, {
    method: 'HEAD',
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`)
  }

  return {
    payload: {
      format: 'pdf',
      url,
    },
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  }
}

/**
 * Derive the framework name from an archive key path.
 * Extracts the top-level documentation area (e.g. 'cocoa', 'general', 'corefoundation').
 *
 * @param {string} key
 * @returns {string|null}
 */
export function deriveFramework(key) {
  const parts = key.split('/')
  const frameworkSegment = parts[2]
  if (!frameworkSegment) return null
  return frameworkSegment.toLowerCase()
}

export class AppleArchiveAdapter extends SourceAdapter {
  static type = 'apple-archive'
  static displayName = 'Apple Developer Archive'
  static syncMode = 'flat'

  constructor() {
    super()
    this._guideCatalog = null
  }

  async discover(ctx) {
    if (ctx.db && !ctx.db.getRootBySlug(ROOT_SLUG)) {
      ctx.db.upsertRoot(ROOT_SLUG, 'Apple Developer Archive', 'collection', ROOT_SLUG)
    }

    const root = ctx.db?.getRootBySlug(ROOT_SLUG) ?? null
    const guides = await this.#loadGuideCatalog(ctx)

    return this.validateDiscoveryResult({
      keys: [...guides.keys()],
      roots: root ? [root] : undefined,
    })
  }

  async fetch(key, ctx) {
    const guides = await this.#loadGuideCatalog(ctx)
    const entry = guides.get(key)
    const url = entry?.url ?? keyToFallbackUrl(key)
    if (entry?.format === 'pdf') {
      const { payload, etag, lastModified } = await fetchArchivePdfMetadata(url, ctx.rateLimiter)
      return this.validateFetchResult({
        key,
        payload: {
          ...payload,
          title: entry.title ?? null,
          sourceMetadata: entry.sourceMetadata ?? null,
        },
        etag,
        lastModified,
      })
    }

    const { html, etag, lastModified } = await fetchHtmlPage(url, ctx.rateLimiter)

    return this.validateFetchResult({
      key,
      payload: html,
      etag,
      lastModified,
    })
  }

  /**
   * Archive content is frozen and never updated by Apple.
   * Always return 'unchanged' to avoid unnecessary network requests.
   */
  async check(_key, _previousState, _ctx) {
    return this.validateCheckResult({
      status: 'unchanged',
      changed: false,
    })
  }

  normalize(key, rawPayload) {
    const entry = this._guideCatalog?.get(key) ?? null
    const url = entry?.url ?? keyToFallbackUrl(key)
    const framework = deriveFramework(key)
    const format = entry?.format ?? (typeof rawPayload === 'object' ? rawPayload?.format : null)

    if (format === 'pdf') {
      return this.validateNormalizeResult({
        document: {
          sourceType: AppleArchiveAdapter.type,
          key,
          title: entry?.title ?? rawPayload?.title ?? key.split('/').pop() ?? key,
          kind: 'archive-guide',
          role: 'article',
          roleHeading: null,
          framework,
          url,
          language: null,
          abstractText: 'Archived PDF guide. Open the original PDF URL for the full document.',
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
          sourceMetadata: entry?.sourceMetadata ?? rawPayload?.sourceMetadata ?? null,
        },
        sections: [
          {
            sectionKind: 'discussion',
            heading: 'Original PDF',
            contentText: `This archive guide is only available as a PDF.\n\nOpen the original document: ${url}`,
            sortOrder: 0,
          },
        ],
        relationships: [],
      })
    }

    const html = typeof rawPayload === 'string' ? rawPayload : String(rawPayload)

    const result = parseHtmlToNormalized(html, key, {
      sourceType: AppleArchiveAdapter.type,
      kind: 'archive-guide',
      framework,
      url,
      sourceMetadata: entry?.sourceMetadata ?? null,
      containerSelector: '#contents',
    })

    return this.validateNormalizeResult(result)
  }

  async #loadGuideCatalog(ctx) {
    if (this._guideCatalog) return this._guideCatalog

    await ctx.rateLimiter.acquire()
    const res = await fetch(ARCHIVE_LIBRARY_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${ARCHIVE_LIBRARY_URL}`)
    }

    const library = parseArchiveLibrary(await res.text())
    const columns = library.columns ?? {}
    const guides = new Map()

    for (const document of library.documents ?? []) {
      const resourceType = String(document[columns.type] ?? '')
      if (resourceType !== GUIDE_RESOURCE_TYPE_KEY) continue

      const relativeUrl = normalizeArchiveRelativeUrl(document[columns.url] ?? '')
      const format = getArchiveFormat(relativeUrl)
      if (!relativeUrl.startsWith('documentation/') && !relativeUrl.startsWith('featuredarticles/')) {
        continue
      }
      if (!ARCHIVE_SUPPORTED_FORMATS.has(format)) continue
      if (KNOWN_MISSING_ARCHIVE_PATHS.has(relativeUrl)) continue

      const key = pathToKey(relativeUrl)
      if (guides.has(key)) continue

      const title = decodeHtmlEntities(document[columns.name])
      const platform = decodeHtmlEntities(document[columns.platform])
      guides.set(key, {
        key,
        title,
        url: `${ARCHIVE_BASE}/${relativeUrl}`,
        sourceMetadata: JSON.stringify({
          resourceType: 'Guides',
          platform,
          archivePath: relativeUrl,
          format,
        }),
        format,
      })
    }

    this._guideCatalog = guides
    return guides
  }
}

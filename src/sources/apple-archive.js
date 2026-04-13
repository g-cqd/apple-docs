import { fetchHtmlPage } from '../apple/api.js'
import { parseHtmlToNormalized } from '../content/parse-html.js'
import { SourceAdapter } from './base.js'

const ROOT_SLUG = 'apple-archive'
const ARCHIVE_BASE = 'https://developer.apple.com/library/archive'
const ARCHIVE_LIBRARY_URL = `${ARCHIVE_BASE}/navigation/library.json`
const GUIDE_RESOURCE_TYPE_KEY = '3'
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
  return new Function(`return (${rawText})`)()
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
  const withoutFilename = guidePath.replace(/\/[^/]+\.html$/, '')
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
    const html = typeof rawPayload === 'string' ? rawPayload : String(rawPayload)
    const entry = this._guideCatalog?.get(key) ?? null
    const url = entry?.url ?? keyToFallbackUrl(key)
    const framework = deriveFramework(key)

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
      if (!relativeUrl.startsWith('documentation/') && !relativeUrl.startsWith('featuredarticles/')) {
        continue
      }

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
        }),
      })
    }

    this._guideCatalog = guides
    return guides
  }
}

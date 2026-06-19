/**
 * DocC archives Apple references from outside developer.apple.com.
 *
 * `technologies.json` links a few documentation sets hosted on third-party
 * origins — CareKit (GitHub Pages), the Private Cloud Compute Security Guide
 * (security.apple.com) and Swift's DocC manual (swift.org). They share the
 * DocC JSON schema, so each becomes its own root and is normalised exactly like
 * the Apple corpus, except the rendered URL points back at the upstream host.
 *
 * The curated set below is always present (deterministic inclusion). discover()
 * additionally scans technologies.json for OTHER external https destinations,
 * recognises the DocC URL shape (docc-url.js) and confirms each with a live
 * probe before adding it — so a non-DocC link (github.com/ResearchKit, the
 * MusicKit JS page) is never crawled.
 *
 * Key form = the canonical doc path (`carekit`, `carekit/octask`). Because the
 * archive slug equals the doc-path root segment, references resolve to
 * slug-scoped keys with no remapping, and BFS stays inside the archive.
 */

import { fetchTechnologies } from '../apple/api.js'
import { extractReferences } from '../apple/extractor.js'
import { extractRootSlug } from '../apple/normalizer.js'
import { normalize } from '../content/normalize.js'
import { NotFoundError } from '../lib/errors.js'
import { checkResourceEtag, fetchWithRetry } from '../lib/fetch-with-retry.js'
import { SourceAdapter } from './base.js'
import { parseDoccArchiveUrl } from './docc-url.js'
import { collectIndexPaths } from './swift-docc.js'

const USER_AGENT = 'apple-docs-mcp/1.0'
const DEFAULT_TIMEOUT = Number.parseInt(process.env.APPLE_DOCS_TIMEOUT ?? '30000', 10)
const HTTP_OPTS = { headers: { 'User-Agent': USER_AGENT }, timeout: DEFAULT_TIMEOUT }
const PROBE_OPTS = { ...HTTP_OPTS, maxRetries: 1 }
const MAX_BFS_PAGES = 5000

/** Always-on archives. baseUrl case matters (GitHub Pages is case-sensitive). */
export const CURATED_ARCHIVES = Object.freeze({
  carekit: { displayName: 'CareKit', kind: 'framework', baseUrl: 'https://carekit-apple.github.io/CareKit' },
  'private-cloud-compute': { displayName: 'Private Cloud Compute Security Guide', kind: 'guide', baseUrl: 'https://security.apple.com' },
  docc: { displayName: 'DocC', kind: 'tooling', baseUrl: 'https://www.swift.org' },
})

const dataUrl = (/** @type {any} */ baseUrl, /** @type {any} */ key) => `${baseUrl}/data/documentation/${key}.json`
const pageUrl = (/** @type {any} */ baseUrl, /** @type {any} */ key) => `${baseUrl}/documentation/${key}`
const indexUrl = (/** @type {any} */ baseUrl) => `${baseUrl}/index/index.json`

/** '/documentation/carekit/octask' → 'carekit/octask' (our storage key form). */
export function indexPathToKey(/** @type {any} */ path) {
  if (typeof path !== 'string') return null
  const m = path.match(/^\/documentation\/(.+)$/i)
  if (!m) return null
  return m[1].replace(/\/+$/, '').toLowerCase()
}

/** A minimal DocC JSON shape check, used to confirm a detected URL is real. */
export function isDoccPayload(/** @type {any} */ data) {
  if (!data || typeof data !== 'object') return false
  if (!data.schemaVersion || typeof data.schemaVersion !== 'object') return false
  return Boolean(data.identifier?.url || data.metadata || data.kind)
}

export class ExternalDoccAdapter extends SourceAdapter {
  static type = 'external-docc'
  static displayName = 'External DocC Archives'
  static syncMode = 'flat'

  constructor() {
    super()
    // slug -> { displayName, kind, baseUrl }. Seeded with the curated set so
    // fetch()/check()/normalize() resolve even before discover() runs (e.g. an
    // incremental update of an already-stored curated page).
    /** @type {Record<string, any>} */
    this.archives = { ...CURATED_ARCHIVES }
  }

  resolveArchive(/** @type {any} */ key) {
    const slug = extractRootSlug(key) ?? ''
    const archive = this.archives[slug]
    if (!archive) throw new NotFoundError(slug, `Unknown external-docc archive: ${slug}`)
    return { slug, archive }
  }

  async discover(/** @type {any} */ ctx) {
    await this.detectFromTechnologies(ctx).catch((e) => ctx.logger?.warn?.(`external-docc: detection skipped: ${e.message}`))

    const roots = []
    const allKeys = []
    for (const [slug, archive] of Object.entries(this.archives)) {
      if (ctx.db) {
        const existing = ctx.db.getRootBySlug(slug)
        if (existing && existing.source_type !== ExternalDoccAdapter.type) {
          ctx.logger?.warn?.(`external-docc: slug '${slug}' already owned by ${existing.source_type}; skipping`)
          continue
        }
        ctx.db.upsertRoot(slug, archive.displayName, archive.kind, ExternalDoccAdapter.type, slug, ExternalDoccAdapter.type)
        const root = ctx.db.getRootBySlug(slug)
        if (root) roots.push(root)
      }
      const keys = await this.enumerate(slug, archive, ctx).catch((e) => {
        ctx.logger?.warn?.(`external-docc: enumerate ${slug} failed: ${e.message}`)
        return []
      })
      for (const key of keys) allKeys.push(key)
    }

    return this.validateDiscoveryResult({ keys: allKeys, roots })
  }

  /** Add DocC archives Apple references beyond the curated set (probe-gated). */
  async detectFromTechnologies(/** @type {any} */ ctx) {
    const { json } = await fetchTechnologies(ctx.rateLimiter)
    const seen = new Set()
    for (const section of json.sections ?? []) {
      for (const group of section.groups ?? []) {
        for (const tech of group.technologies ?? []) {
          const id = tech.destination?.identifier
          if (typeof id !== 'string') continue
          const parsed = parseDoccArchiveUrl(id)
          if (!parsed || this.archives[parsed.slug] || seen.has(parsed.slug)) continue
          seen.add(parsed.slug)
          if (await this.probe(parsed, ctx)) {
            this.archives[parsed.slug] = { displayName: tech.title ?? parsed.slug, kind: 'framework', baseUrl: parsed.baseUrl }
            ctx.logger?.info?.(`external-docc: detected DocC archive '${parsed.slug}' at ${parsed.baseUrl}`)
          }
        }
      }
    }
  }

  async probe(/** @type {any} */ parsed, /** @type {any} */ ctx) {
    try {
      const { data } = await fetchWithRetry(dataUrl(parsed.baseUrl, parsed.entryKey), ctx.rateLimiter, PROBE_OPTS)
      return isDoccPayload(data)
    } catch {
      return false
    }
  }

  /**
   * Enumerate an archive's keys. Prefer index/index.json (one request, complete);
   * fall back to a bounded BFS for archives that ship without one — CareKit's
   * older DocC has no linkable index.
   */
  async enumerate(/** @type {any} */ slug, /** @type {any} */ archive, /** @type {any} */ ctx) {
    const fromIndex = await this.enumerateIndex(slug, archive, ctx)
    if (fromIndex.length > 0) return fromIndex
    return this.enumerateBfs(slug, archive, ctx)
  }

  async enumerateIndex(/** @type {any} */ slug, /** @type {any} */ archive, /** @type {any} */ ctx) {
    try {
      const { data } = await fetchWithRetry(indexUrl(archive.baseUrl), ctx.rateLimiter, PROBE_OPTS)
      const keys = []
      for (const p of collectIndexPaths(data)) {
        const key = indexPathToKey(p)
        if (key && extractRootSlug(key) === slug) keys.push(key)
      }
      return [...new Set(keys)]
    } catch {
      return []
    }
  }

  async enumerateBfs(/** @type {any} */ slug, /** @type {any} */ archive, /** @type {any} */ ctx) {
    const visited = new Set()
    const queue = [slug]
    while (queue.length > 0 && visited.size < MAX_BFS_PAGES) {
      const key = queue.shift()
      if (visited.has(key)) continue
      visited.add(key)
      try {
        const { data } = await fetchWithRetry(dataUrl(archive.baseUrl, key), ctx.rateLimiter, PROBE_OPTS)
        for (const ref of extractReferences(data)) {
          if (extractRootSlug(ref) === slug && !visited.has(ref)) queue.push(ref)
        }
      } catch {
        visited.delete(key) // a missing child is non-fatal — drop it
      }
    }
    return [...visited]
  }

  async fetch(/** @type {any} */ key, /** @type {any} */ ctx) {
    const { archive } = this.resolveArchive(key)
    const { data, etag, lastModified } = await fetchWithRetry(dataUrl(archive.baseUrl, key), ctx.rateLimiter, HTTP_OPTS)
    return this.validateFetchResult({ key, payload: data, etag, lastModified })
  }

  async check(/** @type {any} */ key, /** @type {any} */ previousState, /** @type {any} */ ctx) {
    const { archive } = this.resolveArchive(key)
    const result = await checkResourceEtag(dataUrl(archive.baseUrl, key), previousState?.etag ?? null, ctx.rateLimiter, HTTP_OPTS)
    return this.validateCheckResult({
      status: result.status,
      changed: result.status === 'modified',
      deleted: result.status === 'deleted',
      newState: { etag: result.etag ?? previousState?.etag ?? null },
    })
  }

  normalize(/** @type {any} */ key, /** @type {any} */ rawPayload) {
    const { archive } = this.resolveArchive(key)
    const json = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload
    const result = normalize(json, key, ExternalDoccAdapter.type, {
      urlBuilder: (/** @type {any} */ k) => pageUrl(archive.baseUrl, k),
    })
    result.document.sourceType = ExternalDoccAdapter.type
    return this.validateNormalizeResult(result)
  }

  extractReferences(/** @type {any} */ key, /** @type {any} */ rawPayload) {
    const { slug } = this.resolveArchive(key)
    const json = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload
    return extractReferences(json).filter((ref) => extractRootSlug(ref) === slug)
  }

  renderHints() {
    return { showPlatformBadges: false, showSourceArchive: true }
  }
}

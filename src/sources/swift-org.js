import { fetchHtmlPage, checkHtmlPage } from '../apple/api.js'
import { parseHtmlToNormalized } from '../content/parse-html.js'
import { SourceAdapter } from './base.js'

const ROOT_SLUG = 'swift-org'

/**
 * Curated list of known Swift.org documentation paths.
 * These are stable, well-maintained pages that are unlikely to 404.
 */
const CURATED_PATHS = [
  'documentation',
  'documentation/api-design-guidelines',
  'documentation/standard-library',
  'documentation/articles/zero-to-swift',
  'documentation/articles/value-and-reference-types',
  'documentation/concurrency',
  'documentation/cxx-interop',
  'documentation/embedded-swift',
  'documentation/package-manager',
  'documentation/server',
  'getting-started',
  'getting-started/cli-swiftpm',
  'install',
  'install/linux',
  'install/windows',
  'community',
  'contributing',
  'diversity',
  'about',
  'migration-guide-swift6',
  'platform-support',
]

export class SwiftOrgAdapter extends SourceAdapter {
  static type = 'swift-org'
  static displayName = 'Swift.org Documentation'
  static syncMode = 'flat'

  async discover(ctx) {
    if (ctx.db && !ctx.db.getRootBySlug(ROOT_SLUG)) {
      ctx.db.upsertRoot(ROOT_SLUG, 'Swift.org Documentation', 'collection', ROOT_SLUG)
    }

    const root = ctx.db?.getRootBySlug(ROOT_SLUG) ?? null
    const keys = CURATED_PATHS.map(path => `${ROOT_SLUG}/${path}`)

    return this.validateDiscoveryResult({
      keys,
      roots: root ? [root] : undefined,
    })
  }

  async fetch(key, ctx) {
    const url = `https://swift.org/${key.replace(`${ROOT_SLUG}/`, '')}`
    const { html, etag, lastModified } = await fetchHtmlPage(url, ctx.rateLimiter)

    return this.validateFetchResult({
      key,
      payload: html,
      etag,
      lastModified,
    })
  }

  async check(key, previousState, ctx) {
    const url = `https://swift.org/${key.replace(`${ROOT_SLUG}/`, '')}`
    const result = await checkHtmlPage(url, previousState?.etag ?? null, ctx.rateLimiter)

    return this.validateCheckResult({
      status: result.status,
      changed: result.status === 'modified',
      deleted: result.status === 'deleted',
      newState: { etag: result.etag ?? previousState?.etag ?? null },
    })
  }

  normalize(key, rawPayload) {
    const html = typeof rawPayload === 'string' ? rawPayload : String(rawPayload)
    const url = `https://swift.org/${key.replace(`${ROOT_SLUG}/`, '')}`

    const result = parseHtmlToNormalized(html, key, {
      sourceType: SwiftOrgAdapter.type,
      kind: 'article',
      framework: ROOT_SLUG,
      url,
    })

    return this.validateNormalizeResult(result)
  }
}

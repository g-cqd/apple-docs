import { checkDocPage, fetchDocPage } from '../apple/api.js'
import { extractReferences } from '../apple/extractor.js'
import { normalize } from '../content/normalize.js'
import { discoverRoots } from '../pipeline/discover.js'
import { SourceAdapter } from './base.js'

export class AppleDoccAdapter extends SourceAdapter {
  static type = 'apple-docc'
  static displayName = 'Apple Developer Documentation'

  async discover(/** @type {any} */ ctx) {
    if (!ctx.rootCatalogReady) {
      await discoverRoots(ctx.db, ctx.rateLimiter, ctx.logger)
    }
    const roots = ctx.db.getRoots().filter((/** @type {any} */ root) => root.source_type === AppleDoccAdapter.type)
    return this.validateDiscoveryResult({
      keys: roots.map((/** @type {any} */ root) => root.slug),
      roots,
    })
  }

  async fetch(/** @type {any} */ key, /** @type {any} */ ctx) {
    const result = await fetchDocPage(key, ctx.rateLimiter)
    return this.validateFetchResult({
      key,
      payload: result.json,
      etag: result.etag,
      lastModified: result.lastModified,
    })
  }

  async check(/** @type {any} */ key, /** @type {any} */ previousState, /** @type {any} */ ctx) {
    const result = await checkDocPage(key, previousState?.etag ?? null, ctx.rateLimiter)
    return this.validateCheckResult({
      status: result.status,
      changed: result.status === 'modified',
      deleted: result.status === 'deleted',
      newState: { etag: result.etag ?? previousState?.etag ?? null },
    })
  }

  normalize(/** @type {any} */ key, /** @type {any} */ rawPayload) {
    return this.validateNormalizeResult(normalize(rawPayload, key, AppleDoccAdapter.type))
  }

  extractReferences(/** @type {any} */ _key, /** @type {any} */ rawPayload) {
    return extractReferences(rawPayload)
  }

  renderHints() {
    return { showPlatformBadges: true }
  }
}

import { checkDocPage, fetchDocPage } from '../apple/api.js'
import { extractReferences } from '../apple/extractor.js'
import { normalize } from '../content/normalize.js'
import { discoverRoots } from '../pipeline/discover.js'
import { SourceAdapter } from './base.js'

export class AppleDoccAdapter extends SourceAdapter {
  static type = 'apple-docc'
  static displayName = 'Apple Developer Documentation'

  async discover(ctx) {
    if (!ctx.rootCatalogReady) {
      await discoverRoots(ctx.db, ctx.rateLimiter, ctx.logger)
    }
    const roots = ctx.db.getRoots().filter(root => root.source_type === AppleDoccAdapter.type)
    return this.validateDiscoveryResult({
      keys: roots.map(root => root.slug),
      roots,
    })
  }

  async fetch(key, ctx) {
    const result = await fetchDocPage(key, ctx.rateLimiter)
    return this.validateFetchResult({
      key,
      payload: result.json,
      etag: result.etag,
      lastModified: result.lastModified,
    })
  }

  async check(key, previousState, ctx) {
    const result = await checkDocPage(key, previousState?.etag ?? null, ctx.rateLimiter)
    return this.validateCheckResult({
      status: result.status,
      changed: result.status === 'modified',
      deleted: result.status === 'deleted',
      newState: { etag: result.etag ?? previousState?.etag ?? null },
    })
  }

  normalize(key, rawPayload) {
    return this.validateNormalizeResult(normalize(rawPayload, key, AppleDoccAdapter.type))
  }

  extractReferences(_key, rawPayload) {
    return extractReferences(rawPayload)
  }
}

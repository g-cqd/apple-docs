import { checkHtmlPage, fetchHtmlPage } from '../apple/api.js'
import { GUIDELINES_URL, ROOT_SLUG, parseGuidelinesHtml } from '../apple/guidelines-parser.js'
import { normalize } from '../content/normalize.js'
import { SourceAdapter } from './base.js'

export class GuidelinesAdapter extends SourceAdapter {
  static type = 'guidelines'
  static displayName = 'App Store Review Guidelines'
  static syncMode = 'snapshot'

  async discover(ctx) {
    if (ctx.db && !ctx.db.getRootBySlug(ROOT_SLUG)) {
      ctx.db.upsertRoot(ROOT_SLUG, 'App Store Review Guidelines', 'guidelines', 'html-scrape')
    }

    const root = ctx.db?.getRootBySlug(ROOT_SLUG) ?? null
    return this.validateDiscoveryResult({
      keys: [ROOT_SLUG],
      roots: root ? [root] : undefined,
    })
  }

  async fetch(key, ctx) {
    const { html, etag, lastModified } = await fetchHtmlPage(GUIDELINES_URL, ctx.rateLimiter)
    const parsed = await parseGuidelinesHtml(html)
    const section = key === ROOT_SLUG
      ? null
      : parsed.sections.find(item => item.path === key) ?? null

    return this.validateFetchResult({
      key,
      payload: {
        html,
        etag,
        lastModified,
        lastUpdated: parsed.lastUpdated,
        sections: parsed.sections,
        section,
      },
      etag,
      lastModified,
    })
  }

  async check(_key, previousState, ctx) {
    const result = await checkHtmlPage(GUIDELINES_URL, previousState?.etag ?? null, ctx.rateLimiter)
    return this.validateCheckResult({
      status: result.status,
      changed: result.status === 'modified',
      deleted: result.status === 'deleted',
      newState: { etag: result.etag ?? previousState?.etag ?? null },
    })
  }

  normalize(key, rawPayload) {
    const section = rawPayload?.section ?? rawPayload
    return this.validateNormalizeResult(normalize(section, key, GuidelinesAdapter.type))
  }

  extractReferences(_key, rawPayload) {
    const section = rawPayload?.section ?? rawPayload
    return section?.children ?? []
  }
}

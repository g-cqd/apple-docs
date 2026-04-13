import { checkDocPage, fetchDocPage } from '../apple/api.js'
import { normalize } from '../content/normalize.js'
import { SourceAdapter } from './base.js'

const ROOT_SLUG = 'sample-code'

/**
 * Minimal bootstrap list for environments that haven't yet synced the main
 * DocC corpus. Once the local corpus exists, discovery should come from pages
 * with role='sampleCode' so we can retrieve the full modern sample catalog.
 */
const BOOTSTRAP_SAMPLE_PATHS = [
  'swiftui/food-truck-building-a-swiftui-multiplatform-app',
  'swiftui/composing-swiftui-gestures',
  'swiftui/loading-and-displaying-a-large-data-feed',
  'uikit/implementing-modern-collection-views',
  'uikit/building-high-performance-lists-and-collection-views',
  'uikit/supporting-desktop-class-features-in-your-ipad-app',
  'arkit/creating-a-multiuser-ar-experience',
  'arkit/visualizing-and-interacting-with-a-reconstructed-scene',
  'realitykit/building-an-immersive-experience-with-realitykit',
  'realitykit/creating-a-spaceship-game',
  'coredata/synchronizing-a-local-store-to-the-cloud',
  'widgetkit/keeping-a-widget-up-to-date',
  'combine/using-combine-for-your-app-s-asynchronous-code',
]

/**
 * Adapter that indexes Apple sample code projects by fetching their metadata
 * from Apple's DocC JSON API. Sample code pages share the same DocC JSON
 * format as regular documentation pages.
 *
 * Discovery uses a curated list of well-known sample paths and can also
 * supplement from any pages with role 'sampleCode' already in the DB.
 */
export class SampleCodeAdapter extends SourceAdapter {
  static type = 'sample-code'
  static displayName = 'Apple Sample Code'
  static syncMode = 'flat'

  async discover(ctx) {
    if (ctx.db && !ctx.db.getRootBySlug(ROOT_SLUG)) {
      ctx.db.upsertRoot(ROOT_SLUG, 'Apple Sample Code', 'collection', ROOT_SLUG)
    }

    const root = ctx.db?.getRootBySlug(ROOT_SLUG) ?? null
    const keySet = new Set()

    // Prefer the local DocC corpus as the canonical inventory for modern
    // sample code pages. The main crawl already discovers these with
    // role='sampleCode', which scales much better than a handwritten list.
    const dbSamples = ctx.db?.getPagesByRole?.('sampleCode') ?? []
    for (const page of dbSamples) {
      const docKey = page.key ?? page.path
      if (!docKey) continue
      keySet.add(docKey.startsWith(ROOT_SLUG + '/') ? docKey : `${ROOT_SLUG}/${docKey}`)
    }

    // Fall back to a small bootstrap seed set when the corpus doesn't have
    // any sample-code pages yet.
    if (keySet.size === 0) {
      for (const docPath of BOOTSTRAP_SAMPLE_PATHS) {
        keySet.add(`${ROOT_SLUG}/${docPath}`)
      }
    }

    return this.validateDiscoveryResult({
      keys: [...keySet],
      roots: root ? [root] : undefined,
    })
  }

  async fetch(key, ctx) {
    const docPath = key.replace(`${ROOT_SLUG}/`, '')
    const result = await fetchDocPage(docPath, ctx.rateLimiter)
    return this.validateFetchResult({
      key,
      payload: result.json,
      etag: result.etag,
      lastModified: result.lastModified,
    })
  }

  async check(key, previousState, ctx) {
    const docPath = key.replace(`${ROOT_SLUG}/`, '')
    const result = await checkDocPage(docPath, previousState?.etag ?? null, ctx.rateLimiter)
    return this.validateCheckResult({
      status: result.status,
      changed: result.status === 'modified',
      deleted: result.status === 'deleted',
      newState: { etag: result.etag ?? previousState?.etag ?? null },
    })
  }

  normalize(key, rawPayload) {
    const docPath = key.replace(`${ROOT_SLUG}/`, '')
    const framework = docPath.split('/')[0] ?? null

    // Delegate DocC JSON normalization to the shared normalizer, using
    // 'apple-docc' as the source type so all DocC rendering helpers apply.
    const result = normalize(rawPayload, key, 'apple-docc')

    // Override fields specific to sample-code entries
    result.document.sourceType = SampleCodeAdapter.type
    result.document.kind = 'sample-project'
    result.document.framework = framework
    result.document.url = `https://developer.apple.com/documentation/${docPath}`
    result.document.sourceMetadata = JSON.stringify({
      sampleProject: true,
      frameworks: framework ? [framework] : [],
    })

    return this.validateNormalizeResult(result)
  }
}

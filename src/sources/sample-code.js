import { checkDocPage, fetchDocPage } from '../apple/api.js'
import { normalize } from '../content/normalize.js'
import { SourceAdapter } from './base.js'

const ROOT_SLUG = 'sample-code'

/**
 * Curated list of well-known Apple sample code project paths.
 * Each entry is the doc path relative to /documentation/ (i.e. framework/slug).
 * Discovered from Apple's developer portal and DocC JSON API.
 */
const KNOWN_SAMPLE_PATHS = [
  // SwiftUI
  'swiftui/food-truck-building-a-swiftui-multiplatform-app',
  'swiftui/fruta-building-a-feature-rich-app-with-swiftui',
  'swiftui/introducing-swiftui',
  'swiftui/backyard-birds-building-an-app-with-swiftdata-and-widgets',
  'swiftui/building-a-document-based-app-using-swiftui',
  'swiftui/building-a-great-mac-app-with-swiftui',
  'swiftui/building-custom-views-with-swiftui',
  'swiftui/composing-swiftui-gestures',
  'swiftui/drawing-paths-and-shapes',
  'swiftui/loading-and-displaying-a-large-data-feed',
  // UIKit
  'uikit/implementing-modern-collection-views',
  'uikit/building-high-performance-lists-and-collection-views',
  'uikit/restoring-your-app-s-state-with-swiftui',
  'uikit/navigating-hierarchical-data-using-outline-views',
  'uikit/supporting-desktop-class-features-in-your-ipad-app',
  // ARKit / RealityKit
  'arkit/creating-a-multiuser-ar-experience',
  'arkit/building-an-ar-app-with-realitykit',
  'arkit/visualizing-and-interacting-with-a-reconstructed-scene',
  'realitykit/building-an-immersive-experience-with-realitykit',
  'realitykit/swift-splash-take-a-swim-with-a-new-swiftui-game-built-with-realitykit',
  'realitykit/creating-a-spaceship-game',
  // Core Data / SwiftData
  'coredata/synchronizing-a-local-store-to-the-cloud',
  'coredata/loading-and-displaying-a-large-data-feed',
  'swiftdata/adopting-swiftdata-for-a-core-data-app',
  'swiftdata/building-a-document-based-app-using-swiftdata',
  // WidgetKit
  'widgetkit/building-widgets-using-widgetkit-and-swiftui',
  'widgetkit/adding-widgets-to-the-lock-screen-and-apple-watch',
  'widgetkit/keeping-a-widget-up-to-date',
  // AppKit
  'appkit/building-a-great-mac-app-with-swiftui',
  // Combine / Async
  'combine/using-combine-for-your-app-s-asynchronous-code',
  // Accessibility
  'accessibility/delivering-an-exceptional-accessibility-experience',
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

    // Start from the curated list
    const pathSet = new Set(KNOWN_SAMPLE_PATHS)

    // Supplement with any sample code pages already crawled in the DB
    const dbSamples = ctx.db?.getPagesByRole?.('sampleCode') ?? []
    for (const page of dbSamples) {
      if (page.key && !page.key.startsWith(ROOT_SLUG + '/')) {
        pathSet.add(page.key)
      }
    }

    const keys = [...pathSet].map(docPath => `${ROOT_SLUG}/${docPath}`)

    return this.validateDiscoveryResult({
      keys,
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

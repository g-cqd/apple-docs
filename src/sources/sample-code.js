import { checkDocPage, fetchDocPage } from '../apple/api.js'
import { normalize } from '../content/normalize.js'
import { SourceAdapter } from './base.js'

const ROOT_SLUG = 'sample-code'

/**
 * Bootstrap list for environments that haven't yet synced the main DocC corpus.
 * Sourced from Apple's framework topic sections (entries with role='sampleCode').
 * Once the local corpus exists, discovery supplements from pages with role='sampleCode'.
 */
const BOOTSTRAP_SAMPLE_PATHS = [
  // SwiftUI
  'swiftui/food-truck-building-a-swiftui-multiplatform-app',
  'swiftui/composing-swiftui-gestures',
  'swiftui/loading-and-displaying-a-large-data-feed',
  'swiftui/landmarks-building-an-app-with-liquid-glass',
  'swiftui/wishlist-planning-travel-in-a-swiftui-app',
  'swiftui/building-a-document-based-app-with-swiftui',
  'swiftui/building-a-document-based-app-using-swiftdata',
  'swiftui/creating-accessible-views',
  'swiftui/managing-model-data-in-your-app',
  'swiftui/migrating-from-the-observable-object-protocol-to-the-observable-macro',
  // UIKit
  'uikit/implementing-modern-collection-views',
  'uikit/building-high-performance-lists-and-collection-views',
  'uikit/supporting-desktop-class-features-in-your-ipad-app',
  // visionOS
  'visionos/bot-anist',
  'visionos/destination-video',
  'visionos/diorama',
  'visionos/happybeam',
  'visionos/world',
  'visionos/swift-splash',
  'visionos/accessing-the-main-camera',
  'visionos/building-an-immersive-media-viewing-experience',
  'visionos/building-local-experiences-with-room-tracking',
  'visionos/canyon-crosser-building-a-volumetric-hike-planning-app',
  'visionos/connecting-ipados-and-visionos-apps-over-the-local-network',
  'visionos/displaying-video-from-connected-devices',
  'visionos/drawing-in-the-air-and-on-surfaces-with-a-spatial-stylus',
  'visionos/enabling-video-reflections-in-an-immersive-environment',
  'visionos/exploring_object_tracking_with_arkit',
  'visionos/implementing-object-tracking-in-your-visionos-app',
  'visionos/implementing-shareplay-for-immersive-spaces-in-visionos',
  'visionos/incorporating-real-world-surroundings-in-an-immersive-experience',
  'visionos/locating-and-decoding-barcodes-in-3d-space',
  'visionos/manipulating-entities-with-solid-collisions',
  'visionos/object-tracking-with-reality-composer-pro-experiences',
  'visionos/petite-asteroids-building-a-volumetric-visionos-game',
  'visionos/placing-content-on-detected-planes',
  'visionos/placing-entities-using-head-and-device-transform',
  'visionos/playing-immersive-media-with-realitykit',
  'visionos/tracking-images-in-3d-space',
  'visionos/tracking-points-in-world-space',
  // RealityKit
  'realitykit/building-an-immersive-experience-with-realitykit',
  'realitykit/combining-2d-and-3d-views-in-an-immersive-app',
  'realitykit/composing-interactive-3d-content-with-realitykit-and-reality-composer-pro',
  'realitykit/construct-an-immersive-environment-for-visionos',
  'realitykit/creating-a-spatial-drawing-app-with-realitykit',
  'realitykit/generating-interactive-geometry-with-realitykit',
  'realitykit/presenting-an-artists-scene',
  'realitykit/rendering-stereoscopic-video-with-realitykit',
  'realitykit/responding-to-gestures-on-an-entity',
  'realitykit/transforming-realitykit-entities-with-gestures',
  // ARKit
  'arkit/creating-a-multiuser-ar-experience',
  'arkit/visualizing-and-interacting-with-a-reconstructed-scene',
  // SwiftData
  'swiftdata/adding-and-editing-persistent-data-in-your-app',
  'swiftdata/defining-data-relationships-with-enumerations-and-model-classes',
  'swiftdata/deleting-persistent-data-from-your-app',
  'swiftdata/filtering-and-sorting-persistent-data',
  'swiftdata/maintaining-a-local-copy-of-server-data',
  'swiftdata/preserving-your-apps-model-data-across-launches',
  // CoreData
  'coredata/adopting-swiftdata-for-a-core-data-app',
  'coredata/handling-different-data-types-in-core-data',
  'coredata/linking-data-between-two-core-data-stores',
  'coredata/sharing-core-data-objects-between-icloud-users',
  'coredata/synchronizing-a-local-store-to-the-cloud',
  // Metal
  'metal/capturing-metal-commands-programmatically',
  'metal/drawing-a-triangle-with-metal-4',
  'metal/performing-calculations-on-a-gpu',
  'metal/supporting-simulator-in-a-metal-app',
  'metal/using-function-specialization-to-build-pipeline-variants',
  // Accessibility
  'accessibility/enhancing-the-accessibility-of-your-swiftui-app',
  'accessibility/integrating-accessibility-into-your-app',
  'accessibility/delivering_an_exceptional_accessibility_experience',
  // Photos
  'photokit/bringing-photos-picker-to-your-swiftui-app',
  'photokit/selecting-photos-and-videos-in-ios',
  // AVFoundation / AVKit
  'avfoundation/supporting-coordinated-media-playback',
  'avkit/creating-a-multiview-video-playback-experience-in-visionos',
  // CoreLocation
  'corelocation/adopting-live-updates-in-core-location',
  'corelocation/monitoring-location-changes-with-core-location',
  // GroupActivities
  'groupactivities/building-a-guessing-game-for-visionos',
  'groupactivities/creating-a-collaborative-photo-gallery-with-shareplay',
  // GameKit
  'gamekit/creating-real-time-games',
  'gamekit/creating-turn-based-games',
  // WidgetKit
  'widgetkit/emoji-rangers-supporting-live-activities-interactivity-and-animations',
  'widgetkit/keeping-a-widget-up-to-date',
  // WeatherKit
  'weatherkit/fetching_weather_forecasts_with_weatherkit',
  // TabletopKit
  'tabletopkit/synchronizing-group-gameplay-with-tabletopkit',
  // Combine
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
      keySet.add(docKey.startsWith(`${ROOT_SLUG}/`) ? docKey : `${ROOT_SLUG}/${docKey}`)
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

  renderHints() {
    return { showFrameworkBadges: true }
  }
}

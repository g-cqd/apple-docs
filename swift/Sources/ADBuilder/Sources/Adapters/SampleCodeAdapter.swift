// SampleCodeAdapter — Apple's curated sample-code projects (port of
// src/sources/sample-code.js). Sample pages ARE DocC JSON, so fetch/normalize reuse the
// shared DocC stack (RetryPolicy.fetchWithRetry + DocC.normalizeDocC) exactly like the
// developer.apple.com documentation crawl; `normalize` then stamps the sample-code
// overrides (sourceType/kind/framework/url/sourceMetadata) on the normalized document.
//
// A `flat` (self-enumerating) source. STORAGE-FREE: adapters have no DB access, so this
// ports only the JS BOOTSTRAP path — `discover` returns the hardcoded
// `BOOTSTRAP_SAMPLE_PATHS` seed set. The JS additionally supplements from
// `ctx.db.getPagesByRole('sampleCode')`; that supplement needs a storage seam (see the
// TODO in `discover`) and is intentionally omitted here.
//
// KEY SCOPING (mirrors the JS): keys are `sample-code/<framework>/<sample>` — every key
// is prefixed with the ROOT_SLUG (`sample-code`), while the LEADING segment of the doc
// path (`swiftui`, `visionos`, …) is the FRAMEWORK, not the root. `fetch`/`normalize`
// strip the `sample-code/` prefix to recover the developer.apple.com doc path.

import Foundation
import HTTPTypes
import HTTPTypesFoundation

/// Stateless (the bootstrap seed is static), so a value type gives a genuine `Sendable`
/// conformance — cf. the stateless `SwiftEvolutionAdapter` `struct`.
public struct SampleCodeAdapter: SourceAdapter {
    public static let type = "sample-code"
    public static let displayName = "Apple Sample Code"
    public static let syncMode = SyncMode.flat

    /// The JS `ROOT_SLUG` — the corpus root every sample key is scoped under (== `type`).
    static let rootSlug = "sample-code"
    /// The JS `TUTORIALS_BASE` (apple/api.js) — the DocC JSON API base.
    static let apiBase = "https://developer.apple.com/tutorials/data"
    static let userAgent = "apple-docs-mcp/1.0"
    static let bodyLimit = 64 << 20

    /// Bootstrap list for environments that haven't yet synced the main DocC corpus.
    /// Sourced from Apple's framework topic sections (entries with role='sampleCode').
    /// Copied VERBATIM from the JS `BOOTSTRAP_SAMPLE_PATHS`; each entry is a doc path
    /// (`<framework>/<sample>`) that `discover` scopes to `<rootSlug>/<path>`.
    static let bootstrapSamplePaths: [String] = [
        // SwiftUI
        "swiftui/food-truck-building-a-swiftui-multiplatform-app",
        "swiftui/composing-swiftui-gestures",
        "swiftui/loading-and-displaying-a-large-data-feed",
        "swiftui/landmarks-building-an-app-with-liquid-glass",
        "swiftui/wishlist-planning-travel-in-a-swiftui-app",
        "swiftui/building-a-document-based-app-with-swiftui",
        "swiftui/building-a-document-based-app-using-swiftdata",
        "swiftui/creating-accessible-views",
        "swiftui/managing-model-data-in-your-app",
        "swiftui/migrating-from-the-observable-object-protocol-to-the-observable-macro",
        // UIKit
        "uikit/implementing-modern-collection-views",
        "uikit/building-high-performance-lists-and-collection-views",
        "uikit/supporting-desktop-class-features-in-your-ipad-app",
        // visionOS
        "visionos/bot-anist",
        "visionos/destination-video",
        "visionos/diorama",
        "visionos/happybeam",
        "visionos/world",
        "visionos/swift-splash",
        "visionos/accessing-the-main-camera",
        "visionos/building-an-immersive-media-viewing-experience",
        "visionos/building-local-experiences-with-room-tracking",
        "visionos/canyon-crosser-building-a-volumetric-hike-planning-app",
        "visionos/connecting-ipados-and-visionos-apps-over-the-local-network",
        "visionos/displaying-video-from-connected-devices",
        "visionos/drawing-in-the-air-and-on-surfaces-with-a-spatial-stylus",
        "visionos/enabling-video-reflections-in-an-immersive-environment",
        "visionos/exploring_object_tracking_with_arkit",
        "visionos/implementing-object-tracking-in-your-visionos-app",
        "visionos/implementing-shareplay-for-immersive-spaces-in-visionos",
        "visionos/incorporating-real-world-surroundings-in-an-immersive-experience",
        "visionos/locating-and-decoding-barcodes-in-3d-space",
        "visionos/manipulating-entities-with-solid-collisions",
        "visionos/object-tracking-with-reality-composer-pro-experiences",
        "visionos/petite-asteroids-building-a-volumetric-visionos-game",
        "visionos/placing-content-on-detected-planes",
        "visionos/placing-entities-using-head-and-device-transform",
        "visionos/playing-immersive-media-with-realitykit",
        "visionos/tracking-images-in-3d-space",
        "visionos/tracking-points-in-world-space",
        // RealityKit
        "realitykit/building-an-immersive-experience-with-realitykit",
        "realitykit/combining-2d-and-3d-views-in-an-immersive-app",
        "realitykit/composing-interactive-3d-content-with-realitykit-and-reality-composer-pro",
        "realitykit/construct-an-immersive-environment-for-visionos",
        "realitykit/creating-a-spatial-drawing-app-with-realitykit",
        "realitykit/generating-interactive-geometry-with-realitykit",
        "realitykit/presenting-an-artists-scene",
        "realitykit/rendering-stereoscopic-video-with-realitykit",
        "realitykit/responding-to-gestures-on-an-entity",
        "realitykit/transforming-realitykit-entities-with-gestures",
        // ARKit
        "arkit/creating-a-multiuser-ar-experience",
        "arkit/visualizing-and-interacting-with-a-reconstructed-scene",
        // SwiftData
        "swiftdata/adding-and-editing-persistent-data-in-your-app",
        "swiftdata/defining-data-relationships-with-enumerations-and-model-classes",
        "swiftdata/deleting-persistent-data-from-your-app",
        "swiftdata/filtering-and-sorting-persistent-data",
        "swiftdata/maintaining-a-local-copy-of-server-data",
        "swiftdata/preserving-your-apps-model-data-across-launches",
        // CoreData
        "coredata/adopting-swiftdata-for-a-core-data-app",
        "coredata/handling-different-data-types-in-core-data",
        "coredata/linking-data-between-two-core-data-stores",
        "coredata/sharing-core-data-objects-between-icloud-users",
        "coredata/synchronizing-a-local-store-to-the-cloud",
        // Metal
        "metal/capturing-metal-commands-programmatically",
        "metal/drawing-a-triangle-with-metal-4",
        "metal/performing-calculations-on-a-gpu",
        "metal/supporting-simulator-in-a-metal-app",
        "metal/using-function-specialization-to-build-pipeline-variants",
        // Accessibility
        "accessibility/enhancing-the-accessibility-of-your-swiftui-app",
        "accessibility/integrating-accessibility-into-your-app",
        "accessibility/delivering_an_exceptional_accessibility_experience",
        // Photos
        "photokit/bringing-photos-picker-to-your-swiftui-app",
        "photokit/selecting-photos-and-videos-in-ios",
        // AVFoundation / AVKit
        "avfoundation/supporting-coordinated-media-playback",
        "avkit/creating-a-multiview-video-playback-experience-in-visionos",
        // CoreLocation
        "corelocation/adopting-live-updates-in-core-location",
        "corelocation/monitoring-location-changes-with-core-location",
        // GroupActivities
        "groupactivities/building-a-guessing-game-for-visionos",
        "groupactivities/creating-a-collaborative-photo-gallery-with-shareplay",
        // GameKit
        "gamekit/creating-real-time-games",
        "gamekit/creating-turn-based-games",
        // WidgetKit
        "widgetkit/emoji-rangers-supporting-live-activities-interactivity-and-animations",
        "widgetkit/keeping-a-widget-up-to-date",
        // WeatherKit
        "weatherkit/fetching_weather_forecasts_with_weatherkit",
        // TabletopKit
        "tabletopkit/synchronizing-group-gameplay-with-tabletopkit",
        // Combine
        "combine/using-combine-for-your-app-s-asynchronous-code"
    ]

    public init() {}

    // MARK: - discover (bootstrap seed set only — no storage access)

    public func discover(_ context: SourceContext) async throws -> DiscoveryResult {
        // `source` = the adapter type (JS `upsertRoot(ROOT_SLUG, 'Apple Sample Code',
        // 'collection', ROOT_SLUG)`); source_type is then derived from `source`.
        let root = DiscoveredRoot(
            slug: Self.rootSlug, displayName: Self.displayName, kind: "collection",
            source: Self.type)

        // TODO: DB getPagesByRole supplement (needs a storage seam). The JS PREFERS the
        // local corpus (`ctx.db.getPagesByRole('sampleCode')`) and only falls back to the
        // bootstrap list when it's empty; adapters here are storage-free, so we always
        // return the bootstrap seed. Each doc path is scoped under the `sample-code/` root.
        let keys = Self.bootstrapSamplePaths.map { "\(Self.rootSlug)/\($0)" }
        return DiscoveryResult(keys: keys, roots: [root])
    }

    // MARK: - fetch (the sample page's DocC JSON)

    public func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
        let docPath = Self.stripRootPrefix(key)
        guard let url = URL(string: Self.resolveURL(docPath)) else {
            throw AdapterError.unexpectedPayload("sample-code: malformed data URL for \(key)")
        }
        var get = HTTPRequest(url: url)
        get.method = .get
        get.headerFields[.userAgent] = Self.userAgent
        let response = try await RetryPolicy.fetchWithRetry(
            HTTPClientRequest(get, deadline: .seconds(30)), using: context.client,
            rateLimiter: context.rateLimiter)
        let bytes = try await response.body.collect(upTo: Self.bodyLimit)
        return FetchResult(
            key: key, payload: .json(bytes), etag: response.etag, lastModified: response.lastModified)
    }

    // MARK: - check (conditional HEAD on the data URL)

    public func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
        -> CheckResult
    {
        guard let url = URL(string: Self.resolveURL(Self.stripRootPrefix(key))) else {
            return CheckResult(status: .error, changed: false)
        }
        try await context.rateLimiter.acquire()
        var head = HTTPRequest(url: url)
        head.method = .head
        head.headerFields[.userAgent] = Self.userAgent
        if let previousState { head.headerFields[.ifNoneMatch] = previousState }
        do {
            let response = try await context.client.send(HTTPClientRequest(head, deadline: .seconds(30)))
            switch response.status.code {
                case 304: return CheckResult(status: .unchanged, changed: false, newState: previousState)
                case 404: return CheckResult(status: .deleted, changed: false, deleted: true)
                case 200 ..< 300: return CheckResult(status: .modified, changed: true, newState: response.etag)
                default: return CheckResult(status: .error, changed: false)
            }
        } catch {
            return CheckResult(status: .error, changed: false)
        }
    }

    // MARK: - normalize (shared DocC normalizer + sample-code document overrides)

    public func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
        guard case .json(let bytes) = payload else {
            throw AdapterError.unexpectedPayload("sample-code expects json, got \(payload)")
        }
        let docPath = Self.stripRootPrefix(key)
        let framework = Self.framework(forDocPath: docPath)

        // Delegate to the shared DocC normalizer with source type 'apple-docc' (so every
        // DocC rendering helper applies), then override the sample-code-specific fields —
        // faithfully mirroring the JS `normalize(rawPayload, key, 'apple-docc')` + overrides.
        guard var page = DocC.normalizeDocC(jsonBytes: bytes, key: key, sourceType: "apple-docc") else {
            throw AdapterError.unexpectedPayload("sample-code: unparseable JSON for \(key)")
        }
        page.document.sourceType = Self.type
        page.document.kind = "sample-project"
        page.document.framework = framework
        page.document.url = "https://developer.apple.com/documentation/\(docPath)"
        page.document.sourceMetadata = Self.sampleSourceMetadata(framework)
        return page
    }

    // MARK: - pure key/path helpers (ports of sample-code.js)

    /// `key.replace('sample-code/', '')` — strip the ROOT_SLUG scope to recover the
    /// developer.apple.com doc path. Mirrors JS `String.replace(str, '')` (first match).
    static func stripRootPrefix(_ key: String) -> String {
        guard let range = key.range(of: "\(rootSlug)/") else { return key }
        var out = key
        out.replaceSubrange(range, with: "")
        return out
    }

    /// `docPath.split('/')[0]` — the leading path segment is the FRAMEWORK slug (`swiftui`,
    /// `visionos`, …). `split(omittingEmptySubsequences: false).first` matches JS `[0]`
    /// (an empty doc path yields `""`, never `nil`, exactly like JS `''.split('/')[0]`).
    static func framework(forDocPath docPath: String) -> String? {
        docPath.split(separator: "/", omittingEmptySubsequences: false).first.map(String.init) ?? ""
    }

    /// Port of `resolveUrl` (apple/api.js): `design/*` uses the design base, everything else
    /// the `/documentation/` base. Sample doc paths are framework-scoped, so only the
    /// documentation branch is reachable here, but the mapping is ported verbatim.
    static func resolveURL(_ docPath: String) -> String {
        if docPath.hasPrefix("design/") { return "\(apiBase)/\(docPath).json" }
        return "\(apiBase)/documentation/\(docPath).json"
    }

    /// The JS `JSON.stringify({ sampleProject: true, frameworks: framework ? [framework] : [] })`.
    /// An empty framework is FALSY in JS ⇒ an empty `frameworks` array.
    static func sampleSourceMetadata(_ framework: String?) -> String {
        let frameworks: [JsJson] = (framework?.isEmpty ?? true) ? [] : [.string(framework!)]
        return
            JsJson.object([
                ("sampleProject", .bool(true)),
                ("frameworks", .array(frameworks))
            ])
            .serialized()
    }
}

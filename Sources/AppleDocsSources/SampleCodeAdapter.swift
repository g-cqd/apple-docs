import AemiJSONCore
import AppleDocsContent
public import AppleDocsCore
import OrderedCollections

/// Apple Sample Code projects fetched from Apple's DocC JSON API (Bun `sources/sample-code.js`).
public struct SampleCodeAdapter: SourceAdapter, Sendable {
    private static let rootSlug = "sample-code"

    // @dl:disable -- curated bootstrap sample-code path inventory
    public static let bootstrapSamplePaths: [String] = [
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
        "uikit/implementing-modern-collection-views",
        "uikit/building-high-performance-lists-and-collection-views",
        "uikit/supporting-desktop-class-features-in-your-ipad-app",
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
        "arkit/creating-a-multiuser-ar-experience",
        "arkit/visualizing-and-interacting-with-a-reconstructed-scene",
        "swiftdata/adding-and-editing-persistent-data-in-your-app",
        "swiftdata/defining-data-relationships-with-enumerations-and-model-classes",
        "swiftdata/deleting-persistent-data-from-your-app",
        "swiftdata/filtering-and-sorting-persistent-data",
        "swiftdata/maintaining-a-local-copy-of-server-data",
        "swiftdata/preserving-your-apps-model-data-across-launches",
        "coredata/adopting-swiftdata-for-a-core-data-app",
        "coredata/handling-different-data-types-in-core-data",
        "coredata/linking-data-between-two-core-data-stores",
        "coredata/sharing-core-data-objects-between-icloud-users",
        "coredata/synchronizing-a-local-store-to-the-cloud",
        "metal/capturing-metal-commands-programmatically",
        "metal/drawing-a-triangle-with-metal-4",
        "metal/performing-calculations-on-a-gpu",
        "metal/supporting-simulator-in-a-metal-app",
        "metal/using-function-specialization-to-build-pipeline-variants",
        "accessibility/enhancing-the-accessibility-of-your-swiftui-app",
        "accessibility/integrating-accessibility-into-your-app",
        "accessibility/delivering_an_exceptional_accessibility_experience",
        "photokit/bringing-photos-picker-to-your-swiftui-app",
        "photokit/selecting-photos-and-videos-in-ios",
        "avfoundation/supporting-coordinated-media-playback",
        "avkit/creating-a-multiview-video-playback-experience-in-visionos",
        "corelocation/adopting-live-updates-in-core-location",
        "corelocation/monitoring-location-changes-with-core-location",
        "groupactivities/building-a-guessing-game-for-visionos",
        "groupactivities/creating-a-collaborative-photo-gallery-with-shareplay",
        "gamekit/creating-real-time-games",
        "gamekit/creating-turn-based-games",
        "widgetkit/emoji-rangers-supporting-live-activities-interactivity-and-animations",
        "widgetkit/keeping-a-widget-up-to-date",
        "weatherkit/fetching_weather_forecasts_with_weatherkit",
        "tabletopkit/synchronizing-group-gameplay-with-tabletopkit",
        "combine/using-combine-for-your-app-s-asynchronous-code"
    ]
    // @dl:enable

    // @dl:disable -- SourceAdapter conformance properties
    public init() {}

    public var kind: SourceKind { .sampleCode }
    public var displayName: String { "Apple Sample Code" }

    public var defaultRoot: CorpusRootRecord {
        AdapterHelpers.collectionRoot(
            slug: Self.rootSlug,
            displayName: displayName,
            sourceType: .sampleCode,
            seedPath: "\(Self.rootSlug)/\(Self.bootstrapSamplePaths[0])"
        )
    }

    public var seedKeys: [DocumentKey] {
        Self.bootstrapSamplePaths.compactMap { try? DocumentKey("\(Self.rootSlug)/\($0)") }
    }

    public func dataURL(for key: DocumentKey) throws(SourceError) -> String {
        let docPath = try AdapterHelpers.stripRootPrefix(Self.rootSlug, from: key)
        return "https://developer.apple.com/tutorials/data/documentation/\(docPath).json"
    }
    // @dl:enable

    public func fetch(
        key: DocumentKey,
        previousETag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        let docPath = try AdapterHelpers.stripRootPrefix(Self.rootSlug, from: key)
        let url = try dataURL(for: key)
        return try await AdapterHelpers.fetchTransformed(url: url, previousETag: previousETag, client: client) {
            response throws(SourceError) in
            let base: ConvertedDocument
            do {
                base = try DocCJSONConverter.convert(json: response.body, key: key, sourceType: .appleDocC)
            } catch {
                throw .malformedPayload(url: url, reason: "Sample-code DocC JSON parse error: \(error)")
            }
            let framework = docPath.split(separator: "/").first.map(String.init) ?? Self.rootSlug
            let meta = JSONValue.makeObject {
                ("sampleProject", .bool(true))
                ("frameworks", .array([.string(framework)]))
            }
            let doc = DocumentRecord(
                key: key,
                sourceType: .sampleCode,
                title: base.document.title,
                kind: "sample-project",
                role: base.document.role,
                roleHeading: base.document.roleHeading,
                framework: framework,
                url: "https://developer.apple.com/documentation/\(docPath)",
                language: base.document.language,
                usr: base.document.usr,
                abstractText: base.document.abstractText,
                declarationText: base.document.declarationText,
                headings: base.document.headings,
                availability: base.document.availability,
                platformsJSON: base.document.platformsJSON,
                isDeprecated: base.document.isDeprecated,
                isBeta: base.document.isBeta,
                isReleaseNotes: base.document.isReleaseNotes,
                urlDepth: base.document.urlDepth,
                sourceMetadataJSON: JSONValue.jsonString(meta)
            )
            return (
                ConvertedDocument(
                    document: doc,
                    sections: base.sections,
                    relationships: base.relationships,
                    discoveredKeys: []
                ),
                []
            )
        }
    }
}

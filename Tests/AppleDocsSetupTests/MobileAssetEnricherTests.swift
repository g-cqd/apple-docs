import AppleDocsCore
import AppleDocsPipeline
import AppleDocsStorage
import Foundation
import Testing

@Suite("Xcode MobileAsset documentation enrichment (Bun sources/mobileasset-docs.js)")
struct MobileAssetEnricherTests {
    private func seedFixtureAssetDatabase(at path: String) throws {
        let assetDB = try SQLiteConnection(path: path, options: .readWrite)
        defer { assetDB.close() }
        try assetDB.executeScript(
            """
            CREATE TABLE documents (asset_id TEXT PRIMARY KEY, document BLOB);
            CREATE TABLE attributes (asset_id TEXT, chunk_index INTEGER, title TEXT, content TEXT);
            """
        )
        for (uri, json) in [
            (
                "/documentation/SwiftUI/View",
                #"{"external_id":"s:7SwiftUI4ViewP","platforms":[{"platform":"iOS","introduced":13.0},{"platform":"macOS","introduced":10.15}]}"#
            ),
            ("/documentation/SwiftUI/View#Overview", #"{"external_id":"skip"}"#),
            (
                "/documentation/Metal/using-metal-to-draw-a-views-contents",
                #"{"platforms":[{"platform":"iOS","introduced":17.199999999999999}]}"#
            ),
            (
                "/documentation/Accelerate/vvexpm1(_:_:_:)",
                #"{"external_id":"c:@F@vvexpm1","kind":"symbol","role":"symbol","roleHeading":"Function","modules":["Accelerate"],"platforms":[{"platform":"macOS","introduced":10.7}]}"#
            )
        ] {
            try assetDB.execute(
                "INSERT INTO documents (asset_id, document) VALUES (?, ?)",
                bindings: [.text(uri), .text(json)]
            )
        }
        try assetDB.execute(
            "INSERT INTO attributes (asset_id, chunk_index, title, content) VALUES (?, 0, ?, ?)",
            bindings: [
                .text("/documentation/Accelerate/vvexpm1(_:_:_:)"),
                .text("vvexpm1(_:_:_:)"),
                .text("Calculates e^x - 1 for each element of a vector.")
            ]
        )
    }

    @Test func `backfills NULL USR and platforms, skips #anchor rows and apostrophe variants, and inserts novel pages`()
        throws
    {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("mobileasset-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let assetDBPath = tmpDir.appendingPathComponent("index.sql").path
        try seedFixtureAssetDatabase(at: assetDBPath)

        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        _ = try store.upsertDocument(DocumentRecord(key: try DocumentKey("swiftui/view"), title: "View"))
        _ = try store.upsertDocument(
            DocumentRecord(key: try DocumentKey("metal/using-metal-to-draw-a-view's-contents"), title: "Using Metal")
        )

        let report = try MobileAssetEnricher.enrich(store: store, assetDBPath: assetDBPath)
        #expect(report.pagesScanned == 3 && report.anchorsSkipped == 1)
        #expect(report.usrBackfilled == 1 && report.platformsBackfilled == 2 && report.novelInserted == 1)
        #expect(try store.documentCount() == 3)

        let view = try #require(try store.document(forKey: try DocumentKey("swiftui/view")))
        #expect(view.usr == "s:7SwiftUI4ViewP" && view.availability.ios == "13.0" && view.availability.macos == "10.15")

        let metal = try #require(
            try store.document(forKey: try DocumentKey("metal/using-metal-to-draw-a-view's-contents"))
        )
        #expect(metal.availability.ios == "17.2")

        let novel = try #require(try store.document(forKey: try DocumentKey("accelerate/vvexpm1(_:_:_:)")))
        #expect(novel.usr == "c:@F@vvexpm1" && novel.language == "occ" && novel.availability.macos == "10.7")
        #expect(novel.sourceMetadataJSON?.contains("\"enrichedFrom\":\"xcode-mobileasset\"") == true)
        let sections = try store.sections(forKey: try DocumentKey("accelerate/vvexpm1(_:_:_:)"))
        #expect(sections.first?.contentText.contains("Calculates e^x - 1") == true)
    }
}

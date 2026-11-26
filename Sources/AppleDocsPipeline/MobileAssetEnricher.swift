import AemiJSONCore
public import AppleDocsCore
public import AppleDocsStorage
import Foundation

/// Offline enrichment from Xcode's Developer Documentation MobileAsset (`index.sql` —
/// Bun `sources/mobileasset-docs.js`). Backfills `usr` + `platforms_json` / `min_*` on crawled pages,
/// and inserts novel pages (including pages blocked by Apple's public WAF) without duplicating
/// apostrophe-stripped slugs or `#anchor` section rows.
public enum MobileAssetEnricher: Sendable {
    public static let defaultAssetRoot =
        "/System/Library/AssetsV2/com_apple_MobileAsset_AppleDeveloperDocumentation"

    public struct Report: Hashable, Sendable {
        public var pagesScanned = 0
        public var anchorsSkipped = 0
        public var usrBackfilled = 0
        public var platformsBackfilled = 0
        public var novelInserted = 0
        public var skippedUnchanged = false

        public init() {}
    }

    // @dl:disable -- Apple platform display-name → platforms_json key map
    static let platformKeys: [String: String] = [
        "iOS": "ios",
        "iPadOS": "ipados",
        "Mac Catalyst": "maccatalyst",
        "macOS": "macos",
        "tvOS": "tvos",
        "visionOS": "visionos",
        "watchOS": "watchos"
    ]
    // @dl:enable

    struct BackfillUpdate {
        let id: Int64
        let usr: String?
        let platformsJSON: String?
        let availability: PlatformAvailability?
    }

    struct ExistingEntry {
        let id: Int64
        let hasPlatforms: Bool
        let hasUSR: Bool
    }

    struct NovelCandidate {
        let key: DocumentKey
        let uri: String
        let usr: String?
        let kind: String?
        let role: String?
        let roleHeading: String?
        let moduleName: String?
        let fileName: String?
        let platformsJSON: String?
        let availability: PlatformAvailability
    }

    /// Finds installed documentation assets under `rootDir`, sorted largest (`documents` count) first.
    public static func findLocalAssetDatabases(rootDir: String = defaultAssetRoot) -> [String] {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: rootDir) else { return [] }
        var candidates: [(path: String, count: Int64)] = []
        for entry in entries where entry.hasSuffix(".asset") {
            let dbPath = "\(rootDir)/\(entry)/AssetData/documentation-db/index.sql"
            guard FileManager.default.fileExists(atPath: dbPath),
                let conn = try? SQLiteConnection(path: dbPath, options: .readOnlyImmutable)
            else { continue }
            defer { conn.close() }
            let count = (try? conn.queryOne("SELECT COUNT(*) FROM documents")?.integer(at: 0)) ?? 0
            if count > 0 { candidates.append((dbPath, count)) }
        }
        return candidates.sorted { $0.count > $1.count }.map(\.path)
    }

    /// Merges `assetDBPath` into `store`, skipping when `sync_checkpoint` already records the same path
    /// (unless `full` is `true`).
    public static func runIfNeeded(
        store: CorpusStore,
        assetDBPath: String? = nil,
        full: Bool = false
    ) throws -> Report? {
        guard let resolved = assetDBPath ?? findLocalAssetDatabases().first else { return nil }
        let checkpointKey = "xcode_enrich_asset"
        if !full,
            let stored = try store.connection.queryOne(
                "SELECT value FROM sync_checkpoint WHERE key = ?",
                bindings: [.text(checkpointKey)]
            ),
            try stored.optionalText(at: 0) == resolved
        {
            var skipped = Report()
            skipped.skippedUnchanged = true
            return skipped
        }
        let report = try enrich(store: store, assetDBPath: resolved)
        try store.connection.execute(
            """
            INSERT INTO sync_checkpoint (key, value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            bindings: [.text(checkpointKey), .text(resolved)]
        )
        return report
    }

    /// Merges `assetDBPath` into `store`.
    public static func enrich(
        store: CorpusStore,
        assetDBPath: String,
        sourceTag: String = "xcode-mobileasset"
    ) throws -> Report {
        let asset = try SQLiteConnection(path: assetDBPath, options: .readOnlyImmutable)
        defer { asset.close() }

        let db = store.connection
        let (existing, existingSimplified) = try loadExistingIndex(on: db)
        var report = Report()
        var novel: [NovelCandidate] = []
        var pendingUpdates: [BackfillUpdate] = []

        try asset.forEachRow("SELECT asset_id, CAST(document AS TEXT) FROM documents") { row in
            let uri = try row.text(at: 0)
            if uri.contains("#") {
                report.anchorsSkipped += 1
                return
            }
            report.pagesScanned += 1
            guard let jsonText = try row.optionalText(at: 1),
                let parsed = try? AemiJSON.parse(Array(jsonText.utf8)).root
            else { return }
            let normalized = normalizeAssetURI(uri)
            let usr = parsed["external_id"].string ?? parsed["symbol"]["preciseIdentifier"].string
            let plat = parsePlatforms(parsed["platforms"])

            if let hit = existing[normalized] ?? existingSimplified[simplifyKey(normalized)] {
                let backfillUSR = (usr != nil && !hit.hasUSR) ? usr : nil
                let backfillPlat = !hit.hasPlatforms ? plat : nil
                if backfillUSR != nil { report.usrBackfilled += 1 }
                if backfillPlat != nil { report.platformsBackfilled += 1 }
                if backfillUSR != nil || backfillPlat != nil {
                    pendingUpdates.append(
                        BackfillUpdate(
                            id: hit.id,
                            usr: backfillUSR,
                            platformsJSON: backfillPlat?.json,
                            availability: backfillPlat?.availability
                        )
                    )
                    if pendingUpdates.count >= 5_000 {
                        try applyBackfills(pendingUpdates, on: db)
                        pendingUpdates.removeAll(keepingCapacity: true)
                    }
                }
                return
            }

            guard let docKey = try? DocumentKey(normalized) else { return }
            novel.append(makeNovelCandidate(key: docKey, uri: uri, usr: usr, parsed: parsed, plat: plat))
        }
        if !pendingUpdates.isEmpty { try applyBackfills(pendingUpdates, on: db) }
        report.novelInserted = try insertNovelPages(novel, from: asset, into: store, sourceTag: sourceTag)
        return report
    }
}

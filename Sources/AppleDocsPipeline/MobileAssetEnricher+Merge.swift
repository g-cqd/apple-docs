import AemiJSONCore
import AppleDocsCore
import AppleDocsStorage
import Foundation
import OrderedCollections

extension MobileAssetEnricher {
    static func loadExistingIndex(
        on db: SQLiteConnection
    ) throws -> ([String: ExistingEntry], [String: ExistingEntry]) {
        var existing: [String: ExistingEntry] = [:]
        var simplified: [String: ExistingEntry] = [:]
        try db.forEachRow("SELECT id, key, platforms_json IS NOT NULL, usr IS NOT NULL FROM documents") { row in
            let id = try row.integer(at: 0)
            let key = try row.text(at: 1)
            let entry = ExistingEntry(
                id: id,
                hasPlatforms: (try row.integer(at: 2)) != 0,
                hasUSR: (try row.integer(at: 3)) != 0
            )
            existing[key] = entry
            let simple = simplifyKey(key)
            if simple != key { simplified[simple] = entry }
        }
        return (existing, simplified)
    }

    static func makeNovelCandidate(
        key: DocumentKey,
        uri: String,
        usr: String?,
        parsed: JSON,
        plat: (json: String, availability: PlatformAvailability)?
    ) -> NovelCandidate {
        NovelCandidate(
            key: key,
            uri: uri,
            usr: usr,
            kind: parsed["kind"].string,
            role: parsed["role"].string,
            roleHeading: parsed["roleHeading"].string,
            moduleName: parsed["modules"].array?.first?.string,
            fileName: parsed["fileName"].string,
            platformsJSON: plat?.json,
            availability: plat?.availability ?? .none
        )
    }

    static func applyBackfills(_ updates: [BackfillUpdate], on db: SQLiteConnection) throws {
        try db.transaction {
            for item in updates {
                if let usr = item.usr {
                    try db.execute(
                        "UPDATE documents SET usr = ? WHERE id = ? AND usr IS NULL",
                        bindings: [.text(usr), .integer(item.id)]
                    )
                }
                if let pj = item.platformsJSON, let avail = item.availability {
                    // @dl:disable -- per-column platform backfill UPDATE bindings
                    try db.execute(
                        """
                        UPDATE documents SET
                            platforms_json = ?,
                            min_ios = ?, min_macos = ?, min_watchos = ?, min_tvos = ?, min_visionos = ?,
                            min_ios_num = ?, min_macos_num = ?, min_watchos_num = ?, min_tvos_num = ?, min_visionos_num = ?
                        WHERE id = ? AND platforms_json IS NULL
                        """,
                        bindings: [
                            .text(pj),
                            .optionalText(avail.ios), .optionalText(avail.macos), .optionalText(avail.watchos),
                            .optionalText(avail.tvos), .optionalText(avail.visionos),
                            .optionalInteger(avail.iosNumeric), .optionalInteger(avail.macosNumeric),
                            .optionalInteger(avail.watchosNumeric), .optionalInteger(avail.tvosNumeric),
                            .optionalInteger(avail.visionosNumeric),
                            .integer(item.id)
                        ]
                    )
                    // @dl:enable
                }
            }
        }
    }

    static func insertNovelPages(
        _ novel: [NovelCandidate],
        from asset: SQLiteConnection,
        into store: CorpusStore,
        sourceTag: String
    ) throws -> Int {
        let db = store.connection
        let meta = JSONValue.makeObject { ("enrichedFrom", .string(sourceTag)) }
        let metaText = (try? meta.encodedBytes()).map { String(decoding: $0, as: UTF8.self) }
        var inserted = 0
        let batchSize = 2_500
        var start = 0
        while start < novel.count {
            let slice = novel[start ..< min(start + batchSize, novel.count)]
            start += batchSize
            try db.transaction {
                for item in slice {
                    try insertOneNovelPage(item, from: asset, into: store, on: db, metaText: metaText)
                    inserted += 1
                }
            }
        }
        return inserted
    }

    private static func insertOneNovelPage(
        _ item: NovelCandidate,
        from asset: SQLiteConnection,
        into store: CorpusStore,
        on db: SQLiteConnection,
        metaText: String?
    ) throws {
        let chunkRows = try asset.query(
            "SELECT title, content FROM attributes WHERE asset_id = ? ORDER BY chunk_index",
            bindings: [.text(item.uri)]
        )
        var title =
            item.fileName ?? item.key.rawValue.split(separator: "/").last.map(String.init) ?? item.key.rawValue
        var sections: [DocumentSectionRecord] = []
        for (idx, chunk) in chunkRows.enumerated() {
            let chunkTitle = try chunk.optionalText(at: 0)
            let content = try chunk.optionalText(at: 1) ?? ""
            if idx == 0, let chunkTitle, !chunkTitle.isEmpty { title = chunkTitle }
            sections.append(
                DocumentSectionRecord(
                    sectionKind: "discussion",
                    heading: chunkTitle,
                    contentText: content,
                    sortOrder: idx
                )
            )
        }
        let framework = item.key.rootSlug
        if try db.queryOne("SELECT 1 FROM roots WHERE slug = ?", bindings: [.text(framework)]) == nil {
            try store.upsertRoot(
                CorpusRootRecord(
                    slug: framework,
                    displayName: item.moduleName ?? framework,
                    kind: "framework",
                    sourceType: .appleDocC,
                    seedPath: framework
                )
            )
        }
        let docID = try store.upsertDocument(
            DocumentRecord(
                key: item.key,
                sourceType: .appleDocC,
                title: title,
                kind: item.kind,
                role: item.role,
                roleHeading: item.roleHeading,
                framework: framework,
                url: "https://developer.apple.com\(item.uri)",
                language: languageFromUSR(item.usr),
                usr: item.usr,
                availability: item.availability,
                platformsJSON: item.platformsJSON,
                urlDepth: max(0, item.key.rawValue.split(separator: "/").count - 1),
                sourceMetadataJSON: metaText
            )
        )
        try store.replaceSections(forDocumentID: docID, sections: sections)
    }

    static func normalizeAssetURI(_ uri: String) -> String {
        var s = uri.hasPrefix("/") ? String(uri.dropFirst()) : uri
        if s.lowercased().hasPrefix("documentation/") {
            s = String(s.dropFirst("documentation/".count))
        }
        return s.lowercased()
    }

    static func simplifyKey(_ key: String) -> String {
        key.replacing("'", with: "").replacing("\u{2019}", with: "")
    }

    static func languageFromUSR(_ usr: String?) -> String? {
        guard let usr else { return nil }
        if usr.hasPrefix("s:") { return "swift" }
        if usr.hasPrefix("c:") { return "occ" }
        return nil
    }

    static func parsePlatforms(_ node: JSON) -> (json: String, availability: PlatformAvailability)? {
        guard let items = node.array, !items.isEmpty else { return nil }
        var map = OrderedDictionary<String, JSONValue>()
        var rawStrings: [String: String] = [:]
        for item in items {
            guard let name = item["platform"].string, let key = platformKeys[name] else { continue }
            let num = item["introduced"].double ?? item["introduced"].int.map(Double.init)
            guard let num, let formatted = formatVersion(num) else { continue }
            map[key] = .string(formatted)
            rawStrings[key] = formatted
        }
        guard !map.isEmpty, let encoded = try? JSONValue.object(map).encodedBytes() else { return nil }
        let avail = PlatformAvailability(
            ios: rawStrings["ios"],
            macos: rawStrings["macos"],
            watchos: rawStrings["watchos"],
            tvos: rawStrings["tvos"],
            visionos: rawStrings["visionos"]
        )
        return (String(decoding: encoded, as: UTF8.self), avail)
    }

    static func formatVersion(_ value: Double) -> String? {
        guard value.isFinite, value > 0 else { return nil }
        let rounded = (value * 100).rounded() / 100
        let formatted = String(format: "%.2f", rounded)
        var trimmed = formatted
        while trimmed.hasSuffix("0") { trimmed.removeLast() }
        if trimmed.hasSuffix(".") { trimmed.removeLast() }
        return trimmed.contains(".") ? trimmed : "\(trimmed).0"
    }
}

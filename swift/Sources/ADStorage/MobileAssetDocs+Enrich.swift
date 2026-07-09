// The Xcode-docs MERGE (the JS `enrichFromAsset`, src/sources/mobileasset-docs.js):
// enrich `documents` from the MobileAsset's per-page JSON. Merge discipline
// (duplication-safe by construction, verbatim from the JS):
//   1. ENRICH the keyed intersection — `UPDATE … WHERE id = ?`, never insert:
//      backfill `usr` (always when NULL) and `platforms_json` + min_* columns
//      (only when NULL — the crawl stays authoritative when it has data).
//   2. INSERT every page whose exact key is absent from the corpus, routed
//      through the documents.js upsert + replaceSections statements so FTS
//      triggers, sections, and key uniqueness behave exactly like a crawl.
//   3. SKIP `#anchor` rows entirely: they are section groupings of pages the
//      corpus already stores as `document_sections`.
// Re-running is idempotent (NULL-guarded updates, keyed upserts). Writes go
// through the writable StorageConnection's named-bind statements (the
// AssetsWrite pattern); the asset DB is opened read-only immutable.

import ADJSONCore
import Foundation

/// The `enrichFromAsset` tallies (the JS stats object).
public struct XcodeDocsEnrichStats: Sendable, Equatable {
    public var pages = 0
    public var anchorsSkipped = 0
    public var usrBackfilled = 0
    public var platformsBackfilled = 0
    public var novelInserted = 0

    public init() {}
}

/// A merge failure: the asset would not open, or a project-DB statement failed
/// (the JS lets bun:sqlite throw; the sync phase catches + reports).
public enum XcodeDocsEnrichError: Error, CustomStringConvertible, Sendable, Equatable {
    case assetOpen(path: String)
    case prepare(sql: String, message: String)
    case step(sql: String, message: String)

    public var description: String {
        switch self {
            case .assetOpen(let path):
                return "cannot open documentation asset \(path) (read-only immutable)"
            case .prepare(let sql, let message):
                return "prepare failed (\(message)) for: \(sql.prefix(120))"
            case .step(let sql, let message):
                return "step failed (\(message)) for: \(sql.prefix(120))"
        }
    }
}

extension MobileAssetDocs {
    /// Run the merge against the project corpus (schema ≥ v26 — `documents.usr` must exist).
    /// `apply: false` computes counts without writing (the JS default; the sync phase passes
    /// `apply: true`). `now` stamps created_at/updated_at on novel rows (the JS binds
    /// `new Date().toISOString()`); requires a `StorageConnection(path:writable: true)` when
    /// applying — under the default query_only connection every write silently fails.
    public static func enrichFromAsset(
        _ projectDb: StorageConnection, assetDbPath: String, apply: Bool = false, now: String,
        sourceTag: String = "xcode-mobileasset"
    ) throws(XcodeDocsEnrichError) -> XcodeDocsEnrichStats {
        guard let asset = SQLiteConnection(immutableAssetPath: assetDbPath) else {
            throw XcodeDocsEnrichError.assetOpen(path: assetDbPath)
        }
        let merge = EnrichMerge(
            project: projectDb.conn, asset: asset, apply: apply, now: now, sourceTag: sourceTag)
        return try merge.run()
    }
}

/// One merge run: the pass-1 backfill scan + the pass-2 novel inserts, with the JS's lazy
/// BEGIN / batched-COMMIT shape (5000 rows per transaction) and the finally-ROLLBACK guard.
private final class EnrichMerge {
    /// One corpus row from the existing-keys preload.
    private struct Hit {
        let id: Int64
        let hasPlatforms: Bool
        let hasUsr: Bool
    }

    /// A pass-2 candidate: the projection of the asset page JSON the insert needs (the JS keeps
    /// the whole parsed `doc`; the fields below are the only ones it ever reads).
    private struct NovelPage {
        let key: String
        let uri: String
        let usr: String?
        let fileName: String?
        let module0: String?
        let kind: String?
        let role: String?
        let roleHeading: String?
        let platforms: MobileAssetDocs.ProjectPlatforms?
    }

    private static let batchSize = 5_000  // the JS BATCH

    private let project: SQLiteConnection
    private let asset: SQLiteConnection
    private let apply: Bool
    private let now: String
    private let sourceTag: String
    private var stats = XcodeDocsEnrichStats()
    private var inTxn = false

    init(project: SQLiteConnection, asset: SQLiteConnection, apply: Bool, now: String, sourceTag: String) {
        self.project = project
        self.asset = asset
        self.apply = apply
        self.now = now
        self.sourceTag = sourceTag
    }

    func run() throws(XcodeDocsEnrichError) -> XcodeDocsEnrichStats {
        defer {
            // The JS finally { if (inTxn) ROLLBACK } — never leave a half-open transaction behind.
            if inTxn { try? exec("ROLLBACK") }
        }
        let existing = try loadExisting()
        let novel = try backfillPass(existing: existing)
        try insertPass(novel)
        return stats
    }

    // MARK: - preload

    /// key → (id, platforms_json IS NOT NULL, usr IS NOT NULL) for every corpus document.
    private func loadExisting() throws(XcodeDocsEnrichError) -> [String: Hit] {
        let sql = "SELECT id, key, platforms_json IS NOT NULL AS hp, usr IS NOT NULL AS hu FROM documents"
        let stmt = try prepare(project, sql)
        var out: [String: Hit] = [:]
        while true {
            let rc = stmt.step()
            if rc == SQLite.done { break }
            guard rc == SQLite.row else { throw stepError(project, sql) }
            guard let key = stmt.text(1) else { continue }
            out[key] = Hit(
                id: stmt.int(0) ?? 0, hasPlatforms: (stmt.int(2) ?? 0) != 0,
                hasUsr: (stmt.int(3) ?? 0) != 0)
        }
        return out
    }

    // MARK: - pass 1: keyed-intersection backfill

    /// Scan every asset page: skip `#anchor` rows, backfill matched keys, collect the novel rest.
    private func backfillPass(existing: [String: Hit]) throws(XcodeDocsEnrichError) -> [NovelPage] {
        let scanSQL = "SELECT asset_id, CAST(document AS TEXT) AS document FROM documents"
        let scan = try prepare(asset, scanSQL)
        let setUsr = try prepare(project, "UPDATE documents SET usr = $usr WHERE id = $id AND usr IS NULL")
        let setPlatforms = try prepare(project, EnrichSQL.setPlatforms)
        var novel: [NovelPage] = []
        var sinceCommit = 0
        while true {
            let rc = scan.step()
            if rc == SQLite.done { break }
            guard rc == SQLite.row else { throw stepError(asset, scanSQL) }
            guard let assetId = scan.text(0) else { continue }
            if assetId.contains("#") {
                stats.anchorsSkipped += 1
                continue
            }
            stats.pages += 1
            let key = MobileAssetDocs.normalizeAssetUri(assetId)
            // The JS try { JSON.parse } catch { continue } — a malformed blob skips the page.
            guard let text = scan.text(1),
                let doc = try? ADJSON.parse(text, options: .init(maxDepth: 512)).root
            else { continue }
            // `external_id ?? symbol?.preciseIdentifier ?? null`; "" is falsy at every JS use
            // site (`if (usr …)`, `if (n.usr)`, the `s:`/`c:` prefix probe), so it maps to nil.
            let usr =
                nonEmpty(doc["external_id"].string)
                ?? nonEmpty(doc["symbol"]["preciseIdentifier"].string)
            guard let hit = existing[key] else {
                novel.append(
                    NovelPage(
                        key: key, uri: assetId, usr: usr, fileName: doc["fileName"].string,
                        module0: doc["modules"][index: 0].string, kind: doc["kind"].string,
                        role: doc["role"].string, roleHeading: doc["roleHeading"].string,
                        platforms: MobileAssetDocs.platformsToProject(doc["platforms"])))
                continue
            }
            try begin()
            if let usr, !hit.hasUsr {
                if apply {
                    try runUpdate(setUsr) {
                        $0.bind("usr", .text(usr))
                        $0.bind("id", .int(hit.id))
                    }
                }
                stats.usrBackfilled += 1
            }
            if !hit.hasPlatforms, let plat = MobileAssetDocs.platformsToProject(doc["platforms"]) {
                if apply { try runUpdate(setPlatforms) { Self.bindPlatforms($0, plat, id: hit.id) } }
                stats.platformsBackfilled += 1
            }
            sinceCommit += 1
            if sinceCommit >= Self.batchSize {
                try commit()
                sinceCommit = 0
            }
        }
        try commit()
        return novel
    }

    private static func bindPlatforms(
        _ stmt: any StorageStatement, _ plat: MobileAssetDocs.ProjectPlatforms, id: Int64
    ) {
        stmt.bind("pj", .text(plat.platformsJson))
        stmt.bind("ios", plat.minIos.map(BindValue.text) ?? .null)
        stmt.bind("macos", plat.minMacos.map(BindValue.text) ?? .null)
        stmt.bind("watchos", plat.minWatchos.map(BindValue.text) ?? .null)
        stmt.bind("tvos", plat.minTvos.map(BindValue.text) ?? .null)
        stmt.bind("visionos", plat.minVisionos.map(BindValue.text) ?? .null)
        stmt.bind("iosn", MobileAssetDocs.encodeVersion(plat.minIos).map(BindValue.int) ?? .null)
        stmt.bind("macosn", MobileAssetDocs.encodeVersion(plat.minMacos).map(BindValue.int) ?? .null)
        stmt.bind("watchosn", MobileAssetDocs.encodeVersion(plat.minWatchos).map(BindValue.int) ?? .null)
        stmt.bind("tvosn", MobileAssetDocs.encodeVersion(plat.minTvos).map(BindValue.int) ?? .null)
        stmt.bind("visionosn", MobileAssetDocs.encodeVersion(plat.minVisionos).map(BindValue.int) ?? .null)
        stmt.bind("id", .int(id))
    }

    // MARK: - pass 2: truly-novel inserts

    /// The pass-2 statement bundle (prepared once, reused per page).
    private struct NovelStatements {
        let chunks: any StorageStatement
        let upsertRoot: any StorageStatement
        let upsertDocument: any StorageStatement
        let deleteSections: any StorageStatement
        let insertSection: any StorageStatement
        let deleteRelationships: any StorageStatement
        let setUsrById: any StorageStatement
    }

    private func insertPass(_ novel: [NovelPage]) throws(XcodeDocsEnrichError) {
        guard !novel.isEmpty else { return }
        let statements = NovelStatements(
            chunks: try prepare(
                asset, "SELECT title, content FROM attributes WHERE asset_id = ? ORDER BY chunk_index"),
            upsertRoot: try prepare(project, EnrichSQL.upsertRoot),
            upsertDocument: try prepare(project, EnrichSQL.upsertDocument),
            deleteSections: try prepare(
                project, "DELETE FROM document_sections WHERE document_id = $document_id"),
            insertSection: try prepare(project, EnrichSQL.insertSection),
            deleteRelationships: try prepare(
                project, "DELETE FROM document_relationships WHERE from_key = $from_key"),
            setUsrById: try prepare(project, "UPDATE documents SET usr = $usr WHERE id = $id"))
        try begin()
        for page in novel {
            try insertOne(page, statements)
            // Commit in batches so a fresh run (tens of thousands of novel pages, each an upsert +
            // sections + FTS triggers) is not one giant transaction.
            if stats.novelInserted % Self.batchSize == 0 {
                try commit()
                try begin()
            }
        }
        try commit()
    }

    private func insertOne(_ page: NovelPage, _ stmts: NovelStatements) throws(XcodeDocsEnrichError) {
        // Slug from the URI's first segment — always consistent with the doc key/browse tree.
        // `modules[0]` is a display name and may contain spaces ("Apple News Format"), so it is
        // never used as a slug (only as the root display name below).
        let segments = page.key.components(separatedBy: "/")
        let framework = segments[0].isEmpty ? nil : segments[0]
        // `doc.fileName ?? key.split('/').pop()`, then the first chunk's title when present.
        var title = page.fileName ?? segments[segments.count - 1]
        var sections: [(heading: String?, contentText: String)] = []
        stmts.chunks.bindText(1, page.uri)
        while stmts.chunks.step() == SQLite.row {
            if sections.isEmpty, let chunkTitle = nonEmpty(stmts.chunks.text(0)) { title = chunkTitle }
            sections.append((heading: stmts.chunks.text(0), contentText: stmts.chunks.text(1) ?? ""))
        }
        stmts.chunks.reset()
        stats.novelInserted += 1
        guard apply else { return }
        if let framework {
            // try { upsertRoot } catch { /* exists */ } — a root failure never aborts the page.
            stmts.upsertRoot.bind("slug", .text(framework))
            stmts.upsertRoot.bind("display_name", .text(page.module0 ?? framework))
            stmts.upsertRoot.bind("kind", .text("framework"))
            stmts.upsertRoot.bind("source", .text(sourceTag))
            stmts.upsertRoot.bind(
                "source_type",
                .text(MobileAssetDocs.deriveRootSourceType(slug: framework, kind: "framework")))
            stmts.upsertRoot.bind("now", .text(now))
            while stmts.upsertRoot.step() == SQLite.row { continue }  // RETURNING id, unused
            stmts.upsertRoot.reset()
        }
        let documentId = try upsertDocument(page, framework: framework, title: title, stmts)
        try runUpdate(stmts.deleteSections) { $0.bind("document_id", .int(documentId)) }
        for (index, section) in sections.enumerated() {
            try runUpdate(stmts.insertSection) { stmt in
                stmt.bind("document_id", .int(documentId))
                stmt.bind("section_kind", .text("discussion"))
                stmt.bind("heading", section.heading.map(BindValue.text) ?? .null)
                stmt.bind("content_text", .text(section.contentText))
                stmt.bind("content_json", .null)
                stmt.bind("sort_order", .int(Int64(index)))
            }
        }
        try runUpdate(stmts.deleteRelationships) { $0.bind("from_key", .text(page.key)) }
        if let usr = page.usr {
            try runUpdate(stmts.setUsrById) {
                $0.bind("usr", .text(usr))
                $0.bind("id", .int(documentId))
            }
        }
    }

    /// The documents.js upsert for one novel page; returns the RETURNING id.
    private func upsertDocument(
        _ page: NovelPage, framework: String?, title: String, _ stmts: NovelStatements
    ) throws(XcodeDocsEnrichError) -> Int64 {
        let stmt = stmts.upsertDocument
        let plat = page.platforms
        stmt.bind("source_type", .text("apple-docc"))  // coerceSourceType('apple-docc')
        stmt.bind("key", .text(page.key))
        stmt.bind("title", .text(title))
        stmt.bind("kind", page.kind.map(BindValue.text) ?? .null)
        stmt.bind("role", page.role.map(BindValue.text) ?? .null)
        stmt.bind("role_heading", page.roleHeading.map(BindValue.text) ?? .null)
        stmt.bind(
            "framework",
            (framework ?? MobileAssetDocs.deriveFrameworkFromPath(page.key)).map(BindValue.text) ?? .null)
        stmt.bind("url", .text("https://developer.apple.com\(page.uri)"))
        stmt.bind("language", MobileAssetDocs.languageFromUsr(page.usr).map(BindValue.text) ?? .null)
        stmt.bind("abstract_text", .null)
        stmt.bind("declaration_text", .null)
        stmt.bind("headings", .null)
        stmt.bind("platforms_json", plat.map { BindValue.text($0.platformsJson) } ?? .null)
        stmt.bind("min_ios", plat?.minIos.map(BindValue.text) ?? .null)
        stmt.bind("min_macos", plat?.minMacos.map(BindValue.text) ?? .null)
        stmt.bind("min_watchos", plat?.minWatchos.map(BindValue.text) ?? .null)
        stmt.bind("min_tvos", plat?.minTvos.map(BindValue.text) ?? .null)
        stmt.bind("min_visionos", plat?.minVisionos.map(BindValue.text) ?? .null)
        stmt.bind("min_ios_num", MobileAssetDocs.encodeVersion(plat?.minIos).map(BindValue.int) ?? .null)
        stmt.bind("min_macos_num", MobileAssetDocs.encodeVersion(plat?.minMacos).map(BindValue.int) ?? .null)
        stmt.bind(
            "min_watchos_num", MobileAssetDocs.encodeVersion(plat?.minWatchos).map(BindValue.int) ?? .null)
        stmt.bind("min_tvos_num", MobileAssetDocs.encodeVersion(plat?.minTvos).map(BindValue.int) ?? .null)
        stmt.bind(
            "min_visionos_num", MobileAssetDocs.encodeVersion(plat?.minVisionos).map(BindValue.int) ?? .null)
        stmt.bind("is_deprecated", .null)
        stmt.bind("is_beta", .null)
        stmt.bind("is_release_notes", .null)
        stmt.bind("url_depth", .null)
        // sourceMetadata: { enrichedFrom: sourceTag } → JSON.stringify (documents.js).
        stmt.bind("source_metadata", .text("{\"enrichedFrom\":\(jsonString(sourceTag))}"))
        stmt.bind("content_hash", .null)
        stmt.bind("raw_payload_hash", .null)
        stmt.bind("now", .text(now))
        let rc = stmt.step()
        guard rc == SQLite.row else {
            stmt.reset()
            throw stepError(project, "documents upsert (RETURNING id)")
        }
        let id = stmt.int(0) ?? 0
        stmt.reset()
        return id
    }
}

// MARK: - plumbing (a same-file extension: the merge body stays within the size gate)

extension EnrichMerge {
    private func prepare(
        _ conn: SQLiteConnection, _ sql: String
    ) throws(XcodeDocsEnrichError) -> any StorageStatement {
        guard let stmt = conn.prepareUncached(sql) else {
            throw XcodeDocsEnrichError.prepare(sql: sql, message: conn.lib.errorMessage(conn.db))
        }
        return stmt
    }

    private func stepError(_ conn: SQLiteConnection, _ sql: String) -> XcodeDocsEnrichError {
        .step(sql: sql, message: conn.lib.errorMessage(conn.db))
    }

    /// Bind + step-to-done + reset one write statement.
    private func runUpdate(
        _ stmt: any StorageStatement, _ bind: (any StorageStatement) -> Void
    ) throws(XcodeDocsEnrichError) {
        bind(stmt)
        defer { stmt.reset() }
        while true {
            let rc = stmt.step()
            if rc == SQLite.done { return }
            guard rc == SQLite.row else { throw stepError(project, "enrich write") }
        }
    }

    /// Lazy `BEGIN` (the JS `begin()` — apply-gated, at most one open transaction).
    private func begin() throws(XcodeDocsEnrichError) {
        if apply, !inTxn {
            try exec("BEGIN")
            inTxn = true
        }
    }

    private func commit() throws(XcodeDocsEnrichError) {
        if apply, inTxn {
            try exec("COMMIT")
            inTxn = false
        }
    }

    private func exec(_ sql: String) throws(XcodeDocsEnrichError) {
        let stmt = try prepare(project, sql)
        while stmt.step() == SQLite.row { continue }
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    /// A minimal `JSON.stringify` of one string (quote + escape) for the source_metadata literal.
    private func jsonString(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
                case "\"": out += "\\\""
                case "\\": out += "\\\\"
                case "\n": out += "\\n"
                case "\r": out += "\\r"
                case "\t": out += "\\t"
                default:
                    if scalar.value < 0x20 {
                        out += String(format: "\\u%04x", scalar.value)
                    } else {
                        out.unicodeScalars.append(scalar)
                    }
            }
        }
        return out + "\""
    }
}

/// The write-side SQL, verbatim from the JS repos (file-scope so the merge type stays within the
/// body-length gate).
private enum EnrichSQL {
    /// The backfill UPDATE (the JS `setPlatforms` — NULL-guarded so the crawl's own platform
    /// data is never overwritten).
    static let setPlatforms = """
        UPDATE documents SET
          platforms_json = $pj,
          min_ios = $ios, min_macos = $macos, min_watchos = $watchos, min_tvos = $tvos, min_visionos = $visionos,
          min_ios_num = $iosn, min_macos_num = $macosn, min_watchos_num = $watchosn, min_tvos_num = $tvosn, min_visionos_num = $visionosn
        WHERE id = $id AND platforms_json IS NULL
        """

    /// roots.js `upsertRoot` (also `CrawlPersist.upsertRoot` on the ADWrite side). The enrich
    /// caller always passes `seedPath: null`, so the two `$seed_path` binds are inlined as NULL.
    static let upsertRoot = """
        INSERT INTO roots (slug, display_name, kind, status, source, seed_path, source_type, first_seen, last_seen)
        VALUES ($slug, $display_name, $kind, 'active', $source, NULL, $source_type, $now, $now)
        ON CONFLICT(slug) DO UPDATE SET
          display_name = $display_name,
          kind = CASE WHEN excluded.kind != 'unknown' THEN excluded.kind ELSE roots.kind END,
          seed_path = COALESCE(NULL, roots.seed_path),
          last_seen = $now,
          source = $source,
          source_type = COALESCE($source_type, roots.source_type)
        RETURNING id
        """

    /// documents.js `upsertDocument` (also `CrawlPersist.documentsUpsertSQL` on the ADWrite side —
    /// duplicated because ADStorage cannot import ADWrite).
    static let upsertDocument = """
        INSERT INTO documents (
          source_type, key, title, kind, role, role_heading, framework, url, language,
          abstract_text, declaration_text, headings, platforms_json,
          min_ios, min_macos, min_watchos, min_tvos, min_visionos,
          min_ios_num, min_macos_num, min_watchos_num, min_tvos_num, min_visionos_num,
          is_deprecated, is_beta, is_release_notes, url_depth,
          source_metadata, content_hash, raw_payload_hash, created_at, updated_at
        )
        VALUES (
          $source_type, $key, $title, $kind, $role, $role_heading, $framework, $url, $language,
          $abstract_text, $declaration_text, $headings, $platforms_json,
          $min_ios, $min_macos, $min_watchos, $min_tvos, $min_visionos,
          $min_ios_num, $min_macos_num, $min_watchos_num, $min_tvos_num, $min_visionos_num,
          $is_deprecated, $is_beta, $is_release_notes, $url_depth,
          $source_metadata, $content_hash, $raw_payload_hash, $now, $now
        )
        ON CONFLICT(key) DO UPDATE SET
          source_type = COALESCE($source_type, documents.source_type),
          title = COALESCE($title, documents.title),
          kind = COALESCE($kind, documents.kind),
          role = COALESCE($role, documents.role),
          role_heading = COALESCE($role_heading, documents.role_heading),
          framework = COALESCE($framework, documents.framework),
          url = COALESCE($url, documents.url),
          language = COALESCE($language, documents.language),
          abstract_text = COALESCE($abstract_text, documents.abstract_text),
          declaration_text = COALESCE($declaration_text, documents.declaration_text),
          headings = COALESCE($headings, documents.headings),
          platforms_json = COALESCE($platforms_json, documents.platforms_json),
          min_ios = COALESCE($min_ios, documents.min_ios),
          min_macos = COALESCE($min_macos, documents.min_macos),
          min_watchos = COALESCE($min_watchos, documents.min_watchos),
          min_tvos = COALESCE($min_tvos, documents.min_tvos),
          min_visionos = COALESCE($min_visionos, documents.min_visionos),
          min_ios_num = COALESCE($min_ios_num, documents.min_ios_num),
          min_macos_num = COALESCE($min_macos_num, documents.min_macos_num),
          min_watchos_num = COALESCE($min_watchos_num, documents.min_watchos_num),
          min_tvos_num = COALESCE($min_tvos_num, documents.min_tvos_num),
          min_visionos_num = COALESCE($min_visionos_num, documents.min_visionos_num),
          is_deprecated = COALESCE($is_deprecated, documents.is_deprecated),
          is_beta = COALESCE($is_beta, documents.is_beta),
          is_release_notes = COALESCE($is_release_notes, documents.is_release_notes),
          url_depth = COALESCE($url_depth, documents.url_depth),
          source_metadata = COALESCE($source_metadata, documents.source_metadata),
          content_hash = COALESCE($content_hash, documents.content_hash),
          raw_payload_hash = COALESCE($raw_payload_hash, documents.raw_payload_hash),
          updated_at = $now
        RETURNING id
        """

    /// documents.js `replaceSections`' insert.
    static let insertSection = """
        INSERT INTO document_sections (document_id, section_kind, heading, content_text, content_json, sort_order)
        VALUES ($document_id, $section_kind, $heading, $content_text, $content_json, $sort_order)
        ON CONFLICT(document_id, section_kind, sort_order) DO UPDATE SET
          heading = $heading,
          content_text = $content_text,
          content_json = $content_json
        """
}

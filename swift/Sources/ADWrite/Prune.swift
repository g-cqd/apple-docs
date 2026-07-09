// `prune` — the native port of `src/commands/prune.js`: trim an existing
// corpus to `<dataDir>/scope.json` WITHOUT re-crawling (issue #7). Deletes
// every page whose root falls outside the scope (plus its documents, FTS rows,
// render-index rows, relationships, and on-disk markdown/raw-json/html files),
// optionally drops fonts/symbols, then VACUUMs to reclaim the space.
//
// Requires a scope — refusing to "prune to nothing" by accident is the point.
// `dryRun` reports what would go; the command is idempotent.
//
// Deletion order matters (the JS pruneRoot):
//   1. documents_body_fts by docid (manually maintained — no trigger).
//   2. documents — the `documents_ad` trigger cleans documents_fts +
//      documents_trigram; FK cascades clean sections/chunks/vectors/raw
//      (foreign_keys must be ON — `migrateSchema` enables it).
//   3. document_render_index + document_relationships by key.
//   4. pages (real delete, not the tombstone).
//   5. crawl state + the roots rows themselves.
//
// File deletion stays OUTSIDE each transaction: a crash there leaves orphan
// files (harmless; rerun is idempotent), never a half-deleted DB.

public import ADStorage
import Foundation

/// The prune verb over a writable, migrated corpus.
public enum Prune {
    /// SQLite bound-parameter headroom (default cap 999) — the JS `BATCH`.
    static let batch = 900

    /// One doomed root's plan line (`{ slug, sourceType, pages }`).
    public struct RootPlan: Sendable, Equatable {
        public let slug: String
        public let sourceType: String?
        public let pages: Int
    }

    /// The JS summary object (also the `--json` payload, key order pinned in
    /// the CLI projection).
    public struct Summary: Sendable, Equatable {
        public var status: String
        public var rootsRemoved: Int
        public var rootsKept: Int
        public var pagesRemoved: Int
        public var documentsRemoved: Int
        public var filesRemoved: Int
        public var fontsDropped: Bool
        public var symbolsDropped: Bool
        public var byRoot: [RootPlan]
    }

    /// One roots row (the fields prune reads off `SELECT * FROM roots`).
    struct Root {
        let id: Int64
        let slug: String
        let sourceType: String?
    }

    /// Run prune against `scope` (the caller loads it; a missing scope is the
    /// caller's ValidationError — the CLI owns that message). `now`/`pid` feed
    /// the activity row. Throws ``MaintenanceError`` for scope validation.
    public static func run(
        _ db: SQLiteWriteConnection, dataDir: String, scope: CorpusScope, options: Options
    ) throws -> Summary {
        let roots = try allRoots(db)
        try validateScopeFrameworks(scope, roots: roots)

        let doomed = roots.filter { isOutOfScope($0, scope) }
        let kept = roots.filter { !isOutOfScope($0, scope) }

        // Per-root page counts up front: the dry-run report and the real run
        // share the same accounting.
        var plan: [RootPlan] = []
        for root in doomed {
            let count = Int(
                try db.get(
                    "SELECT COUNT(*) AS c FROM pages WHERE root_id = $id", ["id": .integer(root.id)])?
                    .int("c") ?? 0)
            plan.append(RootPlan(slug: root.slug, sourceType: root.sourceType, pages: count))
        }
        let totalPages = plan.reduce(0) { $0 + $1.pages }

        var summary = Summary(
            status: options.dryRun ? "dry-run" : "ok", rootsRemoved: doomed.count, rootsKept: kept.count,
            pagesRemoved: totalPages, documentsRemoved: 0, filesRemoved: 0,
            fontsDropped: false, symbolsDropped: false, byRoot: plan)

        if options.dryRun {
            reportDryRun(plan, scope: scope, kept: kept.count, log: options.log)
            return summary
        }

        try setActivity(db, roots: doomed.map(\.slug), now: options.now, pid: options.pid)
        defer { try? db.run("DELETE FROM activity WHERE id = 1") }

        for root in doomed {
            let removed = try pruneRoot(db, dataDir: dataDir, root: root, log: options.log)
            summary.documentsRemoved += removed.documents
            summary.filesRemoved += removed.files
        }

        for root in kept {
            try db.run(
                "UPDATE roots SET page_count = (SELECT COUNT(*) FROM pages WHERE root_id = roots.id "
                    + "AND status = 'active') WHERE slug = $slug",
                ["slug": .text(root.slug)])
        }

        try dropResources(db, dataDir: dataDir, scope: scope, summary: &summary)

        // The static-site checkpoint indexes pages that may be gone now.
        try db.run("DELETE FROM sync_checkpoint WHERE key = $key", ["key": .text("web_build")])

        if !options.noVacuum {
            options.log?("Reclaiming free pages (VACUUM)…")
            try db.withFileTempStore { () throws(SQLiteWriteError) in
                try db.run("VACUUM")
            }
            try db.run("PRAGMA wal_checkpoint(TRUNCATE)")
        }

        options.log?(
            "Pruned \(summary.rootsRemoved) roots, \(summary.pagesRemoved) pages, "
                + "\(summary.documentsRemoved) documents, \(summary.filesRemoved) files"
                + "\(summary.fontsDropped ? "; fonts dropped" : "")"
                + "\(summary.symbolsDropped ? "; symbols dropped" : "")")
        return summary
    }

    /// The non-scope inputs (dry-run/vacuum switches, activity stamps, logger)
    /// — bundled to stay within the parameter-count gate.
    public struct Options {
        public let dryRun: Bool
        public let noVacuum: Bool
        public let now: String
        public let pid: Int64
        public let log: ((String) -> Void)?

        public init(
            dryRun: Bool = false, noVacuum: Bool = false, now: String, pid: Int64,
            log: ((String) -> Void)? = nil
        ) {
            self.dryRun = dryRun
            self.noVacuum = noVacuum
            self.now = now
            self.pid = pid
            self.log = log
        }
    }

    // MARK: - scope checks (prune.js)

    /// `isRootOutOfScope(root, scope)`.
    static func isOutOfScope(_ root: Root, _ scope: CorpusScope) -> Bool {
        if let sources = scope.sources, root.sourceType.map({ !sources.contains($0) }) ?? true {
            return true
        }
        if root.sourceType == "apple-docc", let frameworks = scope.appleDoccFrameworks,
            !frameworks.contains(root.slug)
        {
            return true
        }
        return false
    }

    /// Strict framework validation: prune deletes data, so a typo'd framework
    /// slug must error (listing valid ones) instead of silently nuking
    /// everything else. Only slugs of EXISTING apple-docc roots count.
    static func validateScopeFrameworks(_ scope: CorpusScope, roots: [Root]) throws {
        guard let frameworks = scope.appleDoccFrameworks else { return }
        let known = Set(roots.filter { $0.sourceType == "apple-docc" }.map(\.slug))
        let unknown = frameworks.filter { !known.contains($0) }
        guard !unknown.isEmpty else { return }
        let sample = known.sorted().prefix(15).joined(separator: ", ")
        throw MaintenanceError(
            "scope.json: unknown apple-docc framework(s): \(unknown.joined(separator: ", ")). "
                + "Known slugs include: \(sample)\(known.count > 15 ? ", …" : "") "
                + "(apple-docs frameworks lists them all)")
    }

    // MARK: - the deletes

    /// Delete one root's pages + documents + files, in 900-path batches, each
    /// batch's row deletes in ONE transaction (the JS `db.tx`). Returns counts.
    private static func pruneRoot(
        _ db: SQLiteWriteConnection, dataDir: String, root: Root, log: ((String) -> Void)?
    ) throws -> (documents: Int, files: Int) {
        let rows = try db.all(
            "SELECT id, path FROM pages WHERE root_id = $id", ["id": .integer(root.id)])
        let hasBodyFts = try db.hasTable("documents_body_fts")
        let hasRenderIndex = try db.hasTable("document_render_index")
        var documents = 0
        var files = 0

        var start = 0
        while start < rows.count {
            let slice = Array(rows[start ..< min(start + batch, rows.count)])
            start += batch
            let paths = slice.compactMap { $0.text("path") }

            try db.transaction { () throws(SQLiteWriteError) in
                documents += try deleteBatchRows(
                    db, paths: paths, pageIds: slice.compactMap { $0.int("id") },
                    hasBodyFts: hasBodyFts, hasRenderIndex: hasRenderIndex)
            }

            // File deletion outside the transaction (see the header note).
            for path in paths {
                for (dir, ext) in [("markdown", ".md"), ("raw-json", ".json"), ("html", ".html")] {
                    guard let filePath = keyPath(dataDir: dataDir, subdir: dir, key: path, ext: ext),
                        (try? FileManager.default.removeItem(atPath: filePath)) != nil
                    else { continue }
                    files += 1
                }
            }
        }

        try db.run("DELETE FROM crawl_state WHERE root_slug = $slug", ["slug": .text(root.slug)])
        try db.run("DELETE FROM roots WHERE id = $id", ["id": .integer(root.id)])
        log?("  - \(root.slug): \(rows.count) pages, \(documents) documents removed")
        return (documents, files)
    }

    /// One batch's in-transaction deletes (body-fts + render-index + documents
    /// by docid, relationships by from_key, pages by id). Returns the number
    /// of documents deleted.
    private static func deleteBatchRows(
        _ db: SQLiteWriteConnection, paths: [String], pageIds: [Int64],
        hasBodyFts: Bool, hasRenderIndex: Bool
    ) throws(SQLiteWriteError) -> Int {
        let pathList = inList(paths.map(SQLiteValue.text))
        let docIds =
            try db.all(
                "SELECT id FROM documents WHERE key IN (\(pathList.marks))", pathList.params
            )
            .compactMap { $0.int("id") }
        if !docIds.isEmpty {
            let docList = inList(docIds.map(SQLiteValue.integer))
            if hasBodyFts {
                try db.run(
                    "DELETE FROM documents_body_fts WHERE rowid IN (\(docList.marks))", docList.params)
            }
            if hasRenderIndex {
                try db.run(
                    "DELETE FROM document_render_index WHERE doc_id IN (\(docList.marks))", docList.params)
            }
            try db.run("DELETE FROM documents WHERE id IN (\(docList.marks))", docList.params)
        }
        try db.run(
            "DELETE FROM document_relationships WHERE from_key IN (\(pathList.marks))", pathList.params)
        let idList = inList(pageIds.map(SQLiteValue.integer))
        try db.run("DELETE FROM pages WHERE id IN (\(idList.marks))", idList.params)
        return docIds.count
    }

    /// The fonts/symbols drops (`scope.keepFonts === false` /
    /// `scope.keepSymbols === false`): clear the catalogs (+ the manually
    /// maintained sf_symbols_fts and the pre-rendered SVGs) and remove the
    /// resource trees.
    private static func dropResources(
        _ db: SQLiteWriteConnection, dataDir: String, scope: CorpusScope, summary: inout Summary
    ) throws {
        if !scope.keepFonts {
            try db.run("DELETE FROM apple_font_files")
            try db.run("DELETE FROM apple_font_families")
            try? FileManager.default.removeItem(atPath: dataDir + "/resources/fonts")
            summary.fontsDropped = true
        }
        if !scope.keepSymbols {
            if try db.hasTable("sf_symbols_fts") { try db.run("DELETE FROM sf_symbols_fts") }
            if try db.hasTable("sf_symbol_renders") { try db.run("DELETE FROM sf_symbol_renders") }
            try db.run("DELETE FROM sf_symbols")
            try? FileManager.default.removeItem(atPath: dataDir + "/resources/symbols")
            summary.symbolsDropped = true
        }
    }

    // MARK: - small helpers

    private static func allRoots(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) -> [Root] {
        try db.all("SELECT * FROM roots ORDER BY slug")
            .compactMap { row in
                guard let id = row.int("id"), let slug = row.text("slug") else { return nil }
                return Root(id: id, slug: slug, sourceType: row.text("source_type"))
            }
    }

    /// `db.setActivity('prune', roots)` (repos/operations.js) — the singleton
    /// activity row (id = 1) with the JSON roots list.
    private static func setActivity(
        _ db: SQLiteWriteConnection, roots: [String], now: String, pid: Int64
    ) throws(SQLiteWriteError) {
        let serialized =
            (try? JSONSerialization.data(withJSONObject: roots))
            .map { String(decoding: $0, as: UTF8.self) } ?? "[]"
        try db.run(
            "INSERT OR REPLACE INTO activity (id, action, started_at, pid, roots) "
                + "VALUES (1, $action, $started_at, $pid, $roots)",
            [
                "action": .text("prune"), "started_at": .text(now), "pid": .integer(pid),
                "roots": .text(serialized)
            ])
    }

    private static func reportDryRun(
        _ plan: [RootPlan], scope: CorpusScope, kept: Int, log: ((String) -> Void)?
    ) {
        let totalPages = plan.reduce(0) { $0 + $1.pages }
        log?(
            "prune --dry-run: would remove \(plan.count) roots / \(totalPages) pages; keep \(kept) roots")
        for entry in plan {
            log?("  - \(entry.slug) (\(entry.sourceType ?? "null")): \(entry.pages) pages")
        }
        if !scope.keepFonts { log?("  - fonts: would drop catalog + resources/fonts") }
        if !scope.keepSymbols { log?("  - symbols: would drop catalog + renders + resources/symbols") }
    }
}

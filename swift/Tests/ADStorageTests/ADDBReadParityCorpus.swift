// The shared apple-docs-shaped corpus for the B10(c) read-swap parity gate.
//
// `buildSQLite` writes the §2.1 read schema (documents + roots + pages +
// document_sections + document_relationships + the status tables) through the
// SAME dlopen'd libsqlite3 the read path uses, seeds ~16 deterministic rows
// tuned so all five FTS probes hit (view / button / async await / urlsession /
// navigation stack) and read/browse/status have content, and reconstructs
// `documents_fts` (porter+unicode61) exactly as the importer will. `importToADDB`
// imports that file into a fresh ADDB database with the FTS-reconstruction +
// v28-denorm manifest.

import ADDB
import ADDBFTS
import ADDBImport
import ADDBJSON
import ADSQLModel

@testable import ADStorage

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

struct CorpusError: Error { let message: String }

enum Corpus {
    // MARK: - SQLite corpus

    static func buildSQLite(at path: String) throws {
        guard let lib = SQLiteLoader.shared else { throw CorpusError(message: "libsqlite3 unavailable") }
        var raw: OpaquePointer?
        let rc = path.withCString {
            lib.openV2($0, &raw, SQLite.openReadWrite | SQLite.openCreate | SQLite.openNoMutex, nil)
        }
        guard rc == SQLite.ok, let db = raw else { throw CorpusError(message: "open \(path) rc=\(rc)") }
        defer { _ = lib.closeV2(db) }

        func exec(_ sql: String) throws {
            guard let stmt = SQLiteStatement(lib: lib, db: db, sql: sql) else {
                throw CorpusError(message: "prepare failed: \(lib.errorMessage(db))\nSQL: \(sql)")
            }
            var step = lib.step(stmt.stmt)
            while step == SQLite.row { step = lib.step(stmt.stmt) }
            guard step == SQLite.done else {
                throw CorpusError(message: "step rc=\(step): \(lib.errorMessage(db))\nSQL: \(sql)")
            }
        }

        // ── schema ───────────────────────────────────────────────────────────
        try exec(
            """
            CREATE TABLE documents(
              id INTEGER PRIMARY KEY, key TEXT, title TEXT, role TEXT, role_heading TEXT,
              abstract_text TEXT, declaration_text TEXT, headings TEXT, platforms_json TEXT,
              min_ios_num INTEGER, min_macos_num INTEGER, min_watchos_num INTEGER,
              min_tvos_num INTEGER, min_visionos_num INTEGER,
              min_ios TEXT, min_macos TEXT, min_watchos TEXT, min_tvos TEXT, min_visionos TEXT,
              framework TEXT, source_type TEXT, source_metadata TEXT,
              is_deprecated INTEGER, is_beta INTEGER, is_release_notes INTEGER,
              kind TEXT, language TEXT, url_depth INTEGER)
            """)
        try exec(
            "CREATE TABLE roots(id INTEGER PRIMARY KEY, slug TEXT, display_name TEXT, kind TEXT, source_type TEXT)")
        try exec(
            "CREATE TABLE pages(id INTEGER PRIMARY KEY, path TEXT, title TEXT, status TEXT, root_id INTEGER)")
        try exec(
            """
            CREATE TABLE document_sections(
              id INTEGER PRIMARY KEY, document_id INTEGER, section_kind TEXT, heading TEXT,
              content_text TEXT, content_json TEXT, sort_order REAL)
            """)
        try exec(
            """
            CREATE TABLE document_relationships(
              id INTEGER PRIMARY KEY, from_key TEXT, to_key TEXT, relation_type TEXT,
              section TEXT, sort_order REAL)
            """)
        try exec("CREATE TABLE snapshot_meta(key TEXT PRIMARY KEY, value TEXT)")
        try exec("CREATE TABLE update_log(id INTEGER PRIMARY KEY, timestamp TEXT, action TEXT, root_slug TEXT)")
        try exec("CREATE TABLE activity(id INTEGER PRIMARY KEY, action TEXT, started_at TEXT, pid INTEGER, roots TEXT)")
        try exec("CREATE TABLE crawl_state(id INTEGER PRIMARY KEY, root_slug TEXT, status TEXT)")

        // ── roots (swiftui/uikit/foundation present; combine deliberately absent) ─
        for (id, slug, name) in [(1, "swiftui", "SwiftUI"), (2, "uikit", "UIKit"), (3, "foundation", "Foundation")] {
            try exec("INSERT INTO roots VALUES (\(id), '\(slug)', '\(name)', 'framework', 'doc')")
        }

        // ── documents (tier + probe coverage) ────────────────────────────────
        for doc in seedDocs() { try exec(doc.insertSQL()) }

        // ── pages (path = key; some deleted for the status counters) ──────────
        let rootIdBySlug = ["swiftui": 1, "uikit": 2, "foundation": 3]
        for doc in seedDocs() {
            let rid = rootIdBySlug[doc.framework].map { "\($0)" } ?? "NULL"
            try exec(
                "INSERT INTO pages(path, title, status, root_id) VALUES ("
                    + "\(sql(doc.key)), \(sql(doc.title)), 'active', \(rid))")
        }
        try exec("INSERT INTO pages(path, title, status, root_id) VALUES ('doc/swiftui/oldview', 'OldView', 'deleted', 1)")
        try exec("INSERT INTO pages(path, title, status, root_id) VALUES ('doc/uikit/oldcell', 'OldCell', 'deleted', 2)")

        // ── sections (read content for a few keys) ───────────────────────────
        let viewId = idOf("doc/swiftui/view")
        try exec(
            "INSERT INTO document_sections(document_id, section_kind, heading, content_text, content_json, sort_order) "
                + "VALUES (\(viewId), 'content', 'Overview', 'The View protocol is the atom of your UI.', NULL, 0.0)")
        try exec(
            "INSERT INTO document_sections(document_id, section_kind, heading, content_text, content_json, sort_order) "
                + "VALUES (\(viewId), 'topics', 'Creating a view', 'Conform to View and implement body.', NULL, 1.0)")
        let urlsId = idOf("doc/foundation/urlsession")
        try exec(
            "INSERT INTO document_sections(document_id, section_kind, heading, content_text, content_json, sort_order) "
                + "VALUES (\(urlsId), 'content', 'Overview', 'Create a session to run data tasks.', NULL, 0.0)")

        // ── relationships (children / inherits_from for browse + read) ───────
        try exec(
            "INSERT INTO document_relationships(from_key, to_key, relation_type, section, sort_order) "
                + "VALUES ('doc/swiftui/view', 'doc/swiftui/viewbuilder', 'child', 'Topics', 0.0)")
        try exec(
            "INSERT INTO document_relationships(from_key, to_key, relation_type, section, sort_order) "
                + "VALUES ('doc/swiftui/view', 'doc/swiftui/collection', 'inherits_from', NULL, 1.0)")
        for (i, child) in ["doc/swiftui/view", "doc/swiftui/button", "doc/swiftui/list"].enumerated() {
            try exec(
                "INSERT INTO document_relationships(from_key, to_key, relation_type, section, sort_order) "
                    + "VALUES ('doc/swiftui/collection', \(sql(child)), 'child', 'Topics', \(Double(i)))")
        }

        // ── status tables ────────────────────────────────────────────────────
        for (id, ts, action, root) in [
            (1, "2026-01-01T00:00:00Z", "sync", "swiftui"),
            (2, "2026-02-01T00:00:00Z", "sync", "foundation"),
            (3, "2026-03-01T00:00:00Z", "build", nil as String?)
        ] {
            let rootLit = root.map { "'\($0)'" } ?? "NULL"
            try exec("INSERT INTO update_log VALUES (\(id), '\(ts)', '\(action)', \(rootLit))")
        }
        try exec("INSERT INTO activity VALUES (1, 'crawl', '2026-03-01T00:00:00Z', 1, '[\"swiftui\"]')")
        for (id, root, status) in [
            (1, "swiftui", "processed"), (2, "swiftui", "processed"), (3, "swiftui", "pending"),
            (4, "foundation", "processed"), (5, "foundation", "failed")
        ] {
            try exec("INSERT INTO crawl_state VALUES (\(id), '\(root)', '\(status)')")
        }
        for (k, v) in [("snapshot_tier", "full"), ("snapshot_tag", "v1.0.0"), ("build_macos", "26.0")] {
            try exec("INSERT INTO snapshot_meta VALUES ('\(k)', '\(v)')")
        }

        // ── documents_fts (reconstructed EXACTLY as the importer will) ────────
        try exec(
            "CREATE VIRTUAL TABLE documents_fts USING fts5("
                + "title, abstract, declaration, headings, key, tokenize='porter unicode61')")
        try exec(
            "INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key) "
                + "SELECT id, title, abstract_text, declaration_text, headings, key FROM documents")
    }

    // MARK: - ADDB corpus

    /// The FTS-reconstruction + v28-denorm manifest (the read-swap import shape).
    static let manifest = ImportManifest(
        ftsTables: [
            .init(
                name: "documents_fts",
                columns: ["title", "abstract", "declaration", "headings", "key"],
                tokenize: ["porter", "unicode61"],
                source: .init(
                    table: "documents",
                    columns: ["title", "abstract_text", "declaration_text", "headings", "key"]))
        ],
        denorm: [
            ImportManifest.Denorm(
                table: "documents",
                columns: [
                    .init(name: "title_lc", type: .text, valueSQL: "LOWER(title)"),
                    .init(name: "key_lc", type: .text, valueSQL: "LOWER(key)"),
                    .init(
                        name: "year_num", type: .integer,
                        valueSQL: "CAST(json_extract(source_metadata, '$.year') AS INTEGER)"),
                    .init(
                        name: "track_lc", type: .text,
                        valueSQL: "LOWER(COALESCE(json_extract(source_metadata, '$.track'), ''))"),
                    .init(name: "root_slug", type: .text, valueSQL: "framework")
                ],
                lookups: [
                    .init(
                        name: "root_display", type: .text, matchColumn: "framework",
                        lookupTable: "roots", lookupKey: "slug", lookupValue: "display_name",
                        fallbackColumn: "framework")
                ])
        ])

    static func importToADDB(from sqlitePath: String, at addbPath: String) throws {
        let db = try Database.open(at: addbPath, options: DatabaseOptions())
        defer { db.close() }
        db.enableFullTextSearch()
        db.enableJSON()
        _ = try db.importSQLite(from: sqlitePath, manifest: manifest, batchSize: 10_000)
    }

    // MARK: - seed model

    struct Doc {
        var id: Int
        var key: String
        var title: String
        var role: String
        var roleHeading: String
        var abstract: String
        var declaration: String
        var framework: String
        var kind: String
        var language: String
        var sourceType: String
        var metadata: String

        func insertSQL() -> String {
            """
            INSERT INTO documents(
              id, key, title, role, role_heading, abstract_text, declaration_text, headings, platforms_json,
              min_ios_num, min_macos_num, min_watchos_num, min_tvos_num, min_visionos_num,
              min_ios, min_macos, min_watchos, min_tvos, min_visionos,
              framework, source_type, source_metadata, is_deprecated, is_beta, is_release_notes,
              kind, language, url_depth)
            VALUES (\(id), \(sql(key)), \(sql(title)), \(sql(role)), \(sql(roleHeading)),
              \(sql(abstract)), \(sql(declaration)), 'Overview Topics', '[]',
              17, 14, NULL, NULL, NULL, '', '', '', '', '',
              \(sql(framework)), \(sql(sourceType)), \(sql(metadata)), 0, 0, 0,
              \(sql(kind)), \(sql(language)), 3)
            """
        }
    }

    private static func idOf(_ key: String) -> Int { seedDocs().first { $0.key == key }!.id }

    static func seedDocs() -> [Doc] {
        var docs: [Doc] = []
        func add(
            _ key: String, _ title: String, _ abstract: String, declaration: String = "",
            role: String = "symbol", roleHeading: String = "Symbol", framework: String,
            kind: String = "symbol", language: String = "swift", sourceType: String = "doc",
            metadata: String = "{}"
        ) {
            docs.append(
                Doc(
                    id: docs.count + 1, key: key, title: title, role: role, roleHeading: roleHeading,
                    abstract: abstract, declaration: declaration, framework: framework, kind: kind,
                    language: language, sourceType: sourceType, metadata: metadata))
        }

        add("doc/swiftui/collection", "SwiftUI", "Declarative UI framework to build a view hierarchy.",
            role: "collection", roleHeading: "Framework", framework: "swiftui", kind: "collection")
        add("doc/swiftui/view", "View", "A type that represents part of your app's UI. Compose a view hierarchy.",
            declaration: "protocol View", framework: "swiftui")
        add("doc/swiftui/viewbuilder", "ViewBuilder", "A result builder for composing views from closures.",
            declaration: "struct ViewBuilder", framework: "swiftui")
        add("doc/swiftui/button", "Button", "A control that performs an action when the user taps the button.",
            declaration: "struct Button", framework: "swiftui")
        add("doc/swiftui/buttonstyle", "ButtonStyle", "Applies standard interaction behavior to a button.",
            declaration: "protocol ButtonStyle", framework: "swiftui")
        add("doc/swiftui/navigationstack", "NavigationStack",
            "A container view that presents a stack of views over a navigation root.",
            declaration: "struct NavigationStack", framework: "swiftui")
        add("doc/swiftui/asyncawait", "Using async and await",
            "Call an async function and await its result to render data.",
            role: "article", roleHeading: "Article", framework: "swiftui", kind: "article")
        add("doc/swiftui/list", "List", "A container that presents rows of data in a single scrollable view.",
            declaration: "struct List", framework: "swiftui")
        add("doc/foundation/urlsession", "URLSession",
            "An object that coordinates a group of related network data transfer tasks.",
            declaration: "class URLSession", framework: "foundation")
        add("doc/foundation/urlrequest", "URLRequest", "A URL load request that a URLSession task runs.",
            declaration: "struct URLRequest", framework: "foundation")
        add("doc/foundation/data", "Data", "A byte buffer in memory.", declaration: "struct Data",
            framework: "foundation", language: "occ")
        add("doc/uikit/uiview", "UIView", "An object that manages the content for a rectangular area; the base view class.",
            declaration: "class UIView", framework: "uikit", language: "occ")
        add("doc/uikit/uibutton", "UIButton", "A control that executes code in response to a button tap.",
            declaration: "class UIButton", framework: "uikit", language: "occ")
        add("doc/uikit/uinavigationcontroller", "UINavigationController",
            "A container that manages navigation through a stack of view controllers.",
            declaration: "class UINavigationController", framework: "uikit", language: "occ")
        add("doc/combine/asyncsequence", "AsyncSequence", "An async sequence you await over time.",
            declaration: "protocol AsyncSequence", framework: "combine")
        add("wwdc/2024/10144", "Demystify SwiftUI performance",
            "Keep the view body fast and avoid render churn in your navigation stack.",
            role: "article", roleHeading: "Article", framework: "swiftui", kind: "article",
            sourceType: "wwdc", metadata: "{\"year\":2024,\"track\":\"SwiftUI\"}")
        return docs
    }
}

/// Single-quote-doubling SQL string literal (Foundation-free, per-character).
func sql(_ s: String) -> String {
    var out = "'"
    for ch in s {
        out.append(ch)
        if ch == "'" { out.append(ch) }
    }
    out.append("'")
    return out
}

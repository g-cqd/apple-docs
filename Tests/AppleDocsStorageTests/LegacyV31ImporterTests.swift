import AppleDocsCore
import AppleDocsStorage
import Foundation
import Testing

@Suite("LegacyV31Importer")
struct LegacyV31ImporterTests {
    @Test func `detects and imports a synthetic Bun v31 corpus into Swift v1 without mutating source`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-docs-v31-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let legacyPath = tempDir.appendingPathComponent("legacy-v31.db").path
        let swiftPath = tempDir.appendingPathComponent("swift-v1.db").path

        try createSyntheticV31Database(at: legacyPath)
        #expect(try LegacyV31Importer.detectSchema(at: legacyPath) == .legacyBunV31)

        let destination = try CorpusStore(path: swiftPath, options: .readWrite)
        defer { destination.close() }
        #expect(try LegacyV31Importer.detectSchema(on: destination.connection) == .swiftV1)

        let report = try LegacyV31Importer.importDatabase(from: legacyPath, into: destination)
        #expect(report.sourceSchemaVersion == 31)
        #expect(report[.roots] == 1)
        #expect(report[.documents] == 1)
        #expect(report[.sections] == 1)
        #expect(report[.relationships] == 1)
        #expect(report[.sfSymbols] == 1)
        #expect(report[.fontFamilies] == 1)
        #expect(report[.fontFiles] == 1)
        #expect(report[.vectors] == 1)

        let imported = try #require(try destination.document(forKey: try DocumentKey("swiftui/view")))
        #expect(imported.title == "View")
        #expect(imported.usr == "s:7SwiftUI4ViewP")
        #expect(imported.availability.ios == "13.0")

        let ftsRows = try destination.connection.query(
            "SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'View'"
        )
        #expect(ftsRows.count == 1)

        // Page validators and the last full sweep carry over, so the first Swift sync revalidates instead of refetching.
        let crawl = try #require(
            try destination.connection.queryOne("SELECT path, status, etag, last_modified, depth FROM crawl_state")
        )
        #expect(try crawl.text(at: 0) == "swiftui/view" && crawl.text(at: 1) == "done")
        #expect(try crawl.optionalText(at: 2) == "\"e-view\"")
        #expect(try crawl.optionalText(at: 3) == "Tue, 02 Jun 2026 21:22:28 GMT" && crawl.integer(at: 4) == 1)
        let sweep = try destination.connection.queryOne(
            "SELECT value FROM sync_checkpoint WHERE key = 'docc_full_sweep_at'"
        )
        #expect(try sweep?.text(at: 0) == "2026-08-05T17:14:30.390Z")

        let bodyRows = try destination.connection.query(
            "SELECT rowid FROM documents_body_fts WHERE documents_body_fts MATCH 'hierarchy'"
        )
        #expect(bodyRows.count == 1)
    }

    @Test func `rejects non-v31 database during import`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-docs-invalid-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let emptyPath = tempDir.appendingPathComponent("empty.db").path
        let conn = try SQLiteConnection(path: emptyPath, options: .readWrite)
        try conn.executeScript("CREATE TABLE noise (x INTEGER);")
        conn.close()

        let destination = try CorpusStore(path: ":memory:")
        #expect(throws: SQLiteError.unsupportedSchema(found: 0)) {
            _ = try LegacyV31Importer.importDatabase(from: emptyPath, into: destination)
        }
    }

    private func createSyntheticV31Database(at path: String) throws {
        let db = try SQLiteConnection(path: path, options: .readWrite)
        defer { db.close() }
        try db.executeScript(Self.syntheticV31DocsSQL)
        try db.executeScript(Self.syntheticV31AssetsSQL)
    }

    private static let syntheticV31DocsSQL = """
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO schema_meta VALUES ('schema_version', '31');
        INSERT INTO schema_meta VALUES ('docc_full_sweep_at', '2026-08-05T17:14:30.390Z');

        CREATE TABLE roots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'framework', status TEXT NOT NULL DEFAULT 'active',
            source TEXT NOT NULL DEFAULT 'apple', page_count INTEGER NOT NULL DEFAULT 0,
            seed_path TEXT, first_seen TEXT NOT NULL DEFAULT '2026-01-01',
            last_seen TEXT NOT NULL DEFAULT '2026-01-01',
            source_type TEXT NOT NULL DEFAULT 'apple-docc', index_etag TEXT
        );
        INSERT INTO roots (slug, display_name, kind, page_count, seed_path, source_type)
        VALUES ('swiftui', 'SwiftUI', 'framework', 1, 'swiftui', 'apple-docc');

        CREATE TABLE pages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, root_id INTEGER NOT NULL, path TEXT NOT NULL UNIQUE,
            url TEXT NOT NULL, etag TEXT, last_modified TEXT, status TEXT NOT NULL DEFAULT 'active',
            url_depth INTEGER DEFAULT 0
        );
        INSERT INTO pages (root_id, path, url, etag, last_modified, url_depth)
        VALUES (1, 'swiftui/View', 'https://developer.apple.com/documentation/swiftui/view', '"e-view"',
                'Tue, 02 Jun 2026 21:22:28 GMT', 1);

        CREATE TABLE documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_type TEXT NOT NULL DEFAULT 'apple-docc', key TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL, kind TEXT, role TEXT, role_heading TEXT, framework TEXT,
            url TEXT, language TEXT, abstract_text TEXT, declaration_text TEXT,
            headings TEXT, platforms_json TEXT,
            min_ios TEXT, min_macos TEXT, min_watchos TEXT, min_tvos TEXT, min_visionos TEXT,
            is_deprecated INTEGER DEFAULT 0, is_beta INTEGER DEFAULT 0,
            is_release_notes INTEGER DEFAULT 0, url_depth INTEGER DEFAULT 0,
            source_metadata TEXT, content_hash TEXT, raw_payload_hash TEXT,
            min_ios_num INTEGER, min_macos_num INTEGER, min_watchos_num INTEGER,
            min_tvos_num INTEGER, min_visionos_num INTEGER, usr TEXT
        );
        INSERT INTO documents (
            id, source_type, key, title, kind, role, role_heading, framework,
            language, abstract_text, min_ios, min_ios_num, usr
        ) VALUES (
            42, 'apple-docc', 'SwiftUI/View', 'View', 'protocol', 'symbol',
            'Protocol', 'swiftui', 'swift', 'A type that represents part of your app UI.',
            '13.0', 13000000, 's:7SwiftUI4ViewP'
        );

        CREATE TABLE document_sections (
            id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL,
            section_kind TEXT NOT NULL, heading TEXT, content_text TEXT NOT NULL,
            content_json TEXT, sort_order INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO document_sections (document_id, section_kind, heading, content_text, sort_order)
        VALUES (42, 'overview', 'Overview', 'Compose custom views in a hierarchy.', 0);

        CREATE TABLE document_relationships (
            id INTEGER PRIMARY KEY AUTOINCREMENT, from_key TEXT NOT NULL, to_key TEXT NOT NULL,
            relation_type TEXT NOT NULL, section TEXT, sort_order INTEGER DEFAULT 0
        );
        INSERT INTO document_relationships (from_key, to_key, relation_type, section)
        VALUES ('SwiftUI/View', 'SwiftUI/Text', 'reference', 'See Also');

        CREATE TABLE document_vectors (document_id INTEGER PRIMARY KEY, vec BLOB NOT NULL);
        INSERT INTO document_vectors (document_id, vec) VALUES (42, X'DEADBEEF');

        CREATE VIRTUAL TABLE documents_body_fts USING fts5(body, tokenize='porter unicode61');
        INSERT INTO documents_body_fts (rowid, body) VALUES (42, 'Compose custom views in a hierarchy.');
        """

    private static let syntheticV31AssetsSQL = """
        CREATE TABLE sf_symbols (
            name TEXT NOT NULL, scope TEXT NOT NULL,
            categories_json TEXT, keywords_json TEXT, aliases_json TEXT, availability_json TEXT,
            order_index INTEGER, bundle_path TEXT, bundle_version TEXT, updated_at TEXT NOT NULL,
            bitmap_only INTEGER NOT NULL DEFAULT 0, codepoint INTEGER, codepoint_version TEXT,
            render_unsupported INTEGER NOT NULL DEFAULT 0, unsupported_variants TEXT NOT NULL DEFAULT '[]',
            codepoint_attempted_version TEXT,
            PRIMARY KEY (scope, name)
        );
        INSERT INTO sf_symbols (name, scope, updated_at, codepoint)
        VALUES ('star.fill', 'public', '2026-01-01', 1048576);

        CREATE VIRTUAL TABLE sf_symbols_fts USING fts5(name, keywords, categories, aliases);
        INSERT INTO sf_symbols_fts (name, keywords, categories, aliases)
        VALUES ('star.fill', 'favorite', 'objectsandtools', '');

        CREATE TABLE apple_font_families (
            id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
            source_url TEXT, source_sha256 TEXT, source_size INTEGER,
            source_path TEXT, extracted_path TEXT,
            status TEXT NOT NULL DEFAULT 'available', category TEXT, updated_at TEXT NOT NULL
        );
        INSERT INTO apple_font_families (id, display_name, status, updated_at)
        VALUES ('sf-pro', 'SF Pro', 'available', '2026-01-01');

        CREATE TABLE apple_font_files (
            id TEXT PRIMARY KEY, family_id TEXT NOT NULL,
            file_name TEXT NOT NULL, file_path TEXT NOT NULL,
            postscript_name TEXT, style_name TEXT, weight TEXT, variant TEXT,
            italic INTEGER NOT NULL DEFAULT 0, format TEXT,
            source TEXT NOT NULL DEFAULT 'remote', is_variable INTEGER NOT NULL DEFAULT 0,
            axes_json TEXT, sha256 TEXT, size INTEGER, updated_at TEXT NOT NULL
        );
        INSERT INTO apple_font_files (id, family_id, file_name, file_path, format, updated_at)
        VALUES ('sf-pro-regular', 'sf-pro', 'SF-Pro.ttf', 'fonts/SF-Pro.ttf', 'ttf', '2026-01-01');
        """
}

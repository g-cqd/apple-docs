import AppleDocsCore
import AppleDocsStorage
import Foundation
import Testing

@Suite("Corpus schema additive migrations")
struct CorpusSchemaMigrationTests {
    @Test func `opening a database created before added columns adds them without touching rows`() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("schema-mig-\(UUID().uuidString).db")
            .path
        defer { try? FileManager.default.removeItem(atPath: path) }
        let legacy = try SQLiteConnection(path: path, options: .readWrite)
        try legacy.executeScript(
            """
            CREATE TABLE roots (slug TEXT PRIMARY KEY, display_name TEXT NOT NULL);
            INSERT INTO roots (slug, display_name) VALUES ('swiftui', 'SwiftUI');
            """
        )
        legacy.close()

        let store = try CorpusStore(path: path, options: .readWrite)
        defer { store.close() }
        let columns = try store.connection.query("PRAGMA table_info(roots)").map { try $0.text(at: 1) }
        #expect(columns.contains("last_seen"))
        let documentColumns = try store.connection.query("PRAGMA table_info(documents)").map { try $0.text(at: 1) }
        #expect(documentColumns.contains("platforms_json"))
        #expect(try store.connection.queryOne("SELECT display_name FROM roots")?.text(at: 0) == "SwiftUI")
    }

    @Test func `a v1 database created before added columns gains them on the next read-write open`() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("schema-v1-\(UUID().uuidString).db")
            .path
        defer { try? FileManager.default.removeItem(atPath: path) }
        let first = try CorpusStore(path: path, options: .readWrite)
        try first.connection.executeScript("ALTER TABLE roots DROP COLUMN last_seen;")
        first.close()

        let reopened = try CorpusStore(path: path, options: .readWrite)
        defer { reopened.close() }
        let columns = try reopened.connection.query("PRAGMA table_info(roots)").map { try $0.text(at: 1) }
        #expect(columns.contains("last_seen"))
    }

    @Test func `deleting a document also drops its body index row and chunks`() throws {
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        let key = try DocumentKey("swiftui/gone")
        let id = try store.upsertDocument(DocumentRecord(key: key, title: "Gone"))
        try store.replaceSections(
            forDocumentID: id,
            sections: [DocumentSectionRecord(sectionKind: "discussion", contentText: "zebracorn")]
        )
        try store.connection.execute(
            "INSERT INTO document_chunks (document_id, ord, vec_bin) VALUES (?, 0, x'00')",
            bindings: [.integer(id)]
        )
        try store.deleteDocument(forKey: key)
        let body = try store.connection.query(
            "SELECT rowid FROM documents_body_fts WHERE documents_body_fts MATCH 'zebracorn'"
        )
        #expect(body.isEmpty)
        #expect(try store.connection.queryOne("SELECT COUNT(*) FROM document_chunks")?.integer(at: 0) == 0)
    }

    @Test func `a fresh v1 database seeds default framework synonyms`() throws {
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        let aliases = try store.connection
            .query(
                "SELECT alias FROM framework_synonyms WHERE canonical = 'quartzcore' ORDER BY alias"
            )
            .map { try $0.text(at: 0) }
        #expect(aliases == ["coreanimation"])
        let count = try store.connection.queryOne("SELECT COUNT(*) FROM framework_synonyms")?.integer(at: 0)
        #expect(count == 9)
    }
}

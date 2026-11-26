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
}

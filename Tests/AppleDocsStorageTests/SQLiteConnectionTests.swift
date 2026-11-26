import AppleDocsStorage
import Foundation
import Testing

@Suite("SQLiteConnection & SQLiteReaderPool")
struct SQLiteConnectionTests {
    @Test func `executes parameterized CRUD, blobs, and prepared statement reuse`() throws {
        let connection = try SQLiteConnection(path: ":memory:")
        try connection.executeScript(
            """
            CREATE TABLE items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                score REAL,
                payload BLOB
            );
            """
        )

        let bytes: [UInt8] = [0x28, 0xB5, 0x2F, 0xFD, 0x00, 0x42]
        try connection.execute(
            "INSERT INTO items (name, score, payload) VALUES (?, ?, ?)",
            bindings: [.text("SwiftUI"), .real(9.5), .blob(bytes)]
        )
        let firstID = try connection.lastInsertRowID()
        #expect(firstID == 1)

        try connection.execute(
            "INSERT INTO items (name, score, payload) VALUES (?, ?, ?)",
            bindings: [.text("UIKit"), .null, .null]
        )

        let rows = try connection.query("SELECT id, name, score, payload FROM items ORDER BY id")
        #expect(rows.count == 2)
        #expect(try rows[0].integer(at: 0) == 1)
        #expect(try rows[0].text(at: 1) == "SwiftUI")
        #expect(rows[0].values[2] == .real(9.5))
        #expect(try rows[0].optionalBlob(at: 3) == bytes)
        #expect(try rows[1].text(at: 1) == "UIKit")
        #expect(try rows[1].optionalBlob(at: 3) == nil)
    }

    @Test func `rolls back failed transaction and preserves committed data`() throws {
        let connection = try SQLiteConnection(path: ":memory:")
        try connection.executeScript("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);")

        try connection.transaction {
            try connection.execute("INSERT INTO kv (k, v) VALUES (?, ?)", bindings: [.text("a"), .text("1")])
        }

        #expect(throws: SQLiteError.self) {
            try connection.transaction {
                try connection.execute("INSERT INTO kv (k, v) VALUES (?, ?)", bindings: [.text("b"), .text("2")])
                try connection.execute("INSERT INTO kv (k, v) VALUES (?, ?)", bindings: [.text("a"), .text("dup")])
            }
        }

        let rows = try connection.query("SELECT k, v FROM kv ORDER BY k")
        #expect(rows.count == 1)
        #expect(try rows[0].text(at: 0) == "a")
    }

    @Test func `reports closed errors after explicit close and rejects type mismatches`() throws {
        let connection = try SQLiteConnection(path: ":memory:")
        let row = try #require(try connection.queryOne("SELECT 'hello'"))
        #expect(throws: SQLiteError.typeMismatch(column: 0, expected: "INTEGER")) {
            _ = try row.integer(at: 0)
        }
        connection.close()
        #expect(throws: SQLiteError.closed) {
            _ = try connection.query("SELECT 1")
        }
    }

    @Test func `supports WAL, user_version, VACUUM INTO, and concurrent SQLiteReaderPool`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-docs-sqlite-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let dbPath = tempDir.appendingPathComponent("corpus.db").path
        let snapshotPath = tempDir.appendingPathComponent("snapshot.db").path

        let writer = try SQLiteConnection(path: dbPath, options: .readWrite)
        try writer.setUserVersion(1)
        #expect(try writer.userVersion() == 1)
        try writer.executeScript("CREATE TABLE docs (id INTEGER PRIMARY KEY, title TEXT NOT NULL);")
        try writer.transaction {
            for idx in 1 ... 40 {
                try writer.execute(
                    "INSERT INTO docs (id, title) VALUES (?, ?)",
                    bindings: [.integer(Int64(idx)), .text("Doc \(idx)")]
                )
            }
        }
        try writer.vacuumInto(destinationPath: snapshotPath)
        writer.close()

        let pool = SQLiteReaderPool(path: snapshotPath, maxReaders: 3)
        let total = try await withThrowingTaskGroup(of: Int64.self) { group in
            for idx in 1 ... 12 {
                group.addTask {
                    try await pool.withConnection { conn in
                        let row = try conn.queryOne(
                            "SELECT id FROM docs WHERE id = ?",
                            bindings: [.integer(Int64(idx))]
                        )
                        return try row?.integer(at: 0) ?? 0
                    }
                }
            }
            var sum: Int64 = 0
            for try await value in group {
                sum += value
            }
            return sum
        }
        #expect(total == 78)
        #expect(await pool.totalCreatedConnections <= 3)
        await pool.close()
    }

    /// Sequential callers must get the same connection back (its page cache stays warm): the release has to complete
    /// before `withConnection` returns.
    @Test func `sequential use of the reader pool reuses one connection`() async throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("pool-seq-\(UUID().uuidString).db")
            .path
        defer { try? FileManager.default.removeItem(atPath: path) }
        try CorpusStore(path: path, options: .readWrite).close()
        let pool = SQLiteReaderPool(path: path, maxReaders: 4)
        for _ in 0 ..< 200 {
            _ = try await pool.withConnection { try $0.queryOne("SELECT 1")?.integer(at: 0) }
        }
        #expect(await pool.totalCreatedConnections == 1)
        await pool.close()
    }
}

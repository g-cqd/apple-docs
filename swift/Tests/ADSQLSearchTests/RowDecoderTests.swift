// Unit gate for `RowDecoder` (W3.6) — the by-name typed `SQLRow` extractor the ported reads decode
// through. Verifies each coercion (text/int/double/blob), the double-accepts-integer rule, and the
// null-vs-absent-vs-type-mismatch distinctions, over a tiny inline table.
//
// Split into one @Test per rule family (shared decode helper, file-scope typed fixtures) to stay
// inside the package's 100 ms type-check budget — the single-body form tripped the hard gate.

import ADDB
import ADSQLModel
import Foundation
import Testing

@testable import ADSQLSearch

private let sampleBlob: [UInt8] = [0x00, 0xFF]
private let insertParams: [String: Value] = [
    "s": .text("hi"), "i": .integer(42), "r": .real(2.5),
    "b": .blob(sampleBlob), "n": .null
]

@Suite("RowDecoder")
struct RowDecoderTests {
    /// Builds a one-row table covering every storage class and returns the decoded row
    /// (`RowDecoder` is self-contained, so the temp DB can close before the asserts run).
    private func decodedRow() throws -> RowDecoder {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("addb-rowdec-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try Database.open(at: dir.appendingPathComponent("t.adsql").path, options: DatabaseOptions())
        defer { db.close() }

        _ = try db.prepare("CREATE TABLE t (s TEXT, i INTEGER, r REAL, b BLOB, n INTEGER)").run()
        _ = try db.prepare("INSERT INTO t (s, i, r, b, n) VALUES ($s, $i, $r, $b, $n)").run(insertParams)

        let row = try #require(try db.prepare("SELECT s, i, r, b, n FROM t").all().first)
        return row.decode()
    }

    @Test("typed by-name extraction returns each matching type")
    func decodesMatchingTypes() throws {
        let d = try decodedRow()
        #expect(d.text("s") == "hi")
        #expect(d.int("i") == 42)
        #expect(d.double("r") == 2.5)
        #expect(d.blob("b") == sampleBlob)
    }

    @Test("double() accepts INTEGER; other type mismatches read as nil")
    func appliesCoercionRules() throws {
        let d = try decodedRow()
        // double() accepts a stored INTEGER (a numeric column may hold either).
        #expect(d.double("i") == 42.0)
        // Type mismatch → nil (present, but wrong type): text() on an INTEGER cell.
        #expect(d.text("i") == nil)
        #expect(d.int("s") == nil)
    }

    @Test("NULL and absent columns read as null; present cells do not")
    func distinguishesNullAndAbsent() throws {
        let d = try decodedRow()
        #expect(d.isNull("n"))
        #expect(d.int("n") == nil)
        #expect(d.isNull("missing"))  // absent column reads as null
        #expect(!d.isNull("s"))  // present non-null
    }
}

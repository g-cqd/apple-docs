// Gate for `searchPagesDenormRows` — the structured ADDB search the cascade port consumes. Proves the
// RowDecoder-based decode of the §2.3 projection produces the expected fields AND that the row COUNT
// agrees with the proven framed `searchPagesFramedDenorm` output (the §2.5 header's rowCount), tying the
// structured path to the byte path.
//
// Split into one @Test per assertion family (shared seed-and-search helper, file-scope typed fixtures)
// to stay inside the package's 100 ms type-check budget — the single-body form tripped the hard gate.

import ADDB
import ADDBFTS
import ADSQLModel
import Foundation
import Testing

@testable import ADSQLSearch

private let seedTimestamp = "2026-06-21T00:00:00.000Z"

/// Named bindings for one seeded `documents` row (swiftui Protocol symbol, not deprecated).
private func documentParams(key: String, title: String, abstract: String) -> [String: Value] {
    [
        "key": .text(key), "title": .text(title), "abstract": .text(abstract),
        "framework": .text("swiftui"), "rh": .text("Protocol"), "kind": .text("symbol")
    ]
}

/// Reads the framed output's rowCount — the LE u32 at offset 4 of the §2.5 `[colCount][rowCount]` header.
private func framedRowCount(_ framed: [UInt8]) -> Int {
    Int(framed[4]) | Int(framed[5]) << 8 | Int(framed[6]) << 16 | Int(framed[7]) << 24
}

@Suite("structured ADDB search rows (searchPagesDenormRows)")
struct SearchProjectionRowsTests {
    /// Seeds two docs matching "view", runs the denorm search through both paths, and returns the
    /// structured rows plus the framed bytes (both self-contained, so the temp DB can close first).
    private func searchOutputs() throws -> (rows: [SearchProjectionRow], framed: [UInt8]) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("addb-rows-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try Database.open(at: dir.appendingPathComponent("t.adsql").path, options: DatabaseOptions())
        defer { db.close() }
        try migrateAddbSchema(db)
        db.enableFullTextSearch()  // direct-insert seeding fires the FTS trigger (see equivalence test)

        _ = try upsertRootAddb(
            db, slug: "swiftui", displayName: "SwiftUI", kind: "framework", source: "apple",
            seedPath: nil, sourceType: nil, now: seedTimestamp)

        let insert = try db.prepare(
            """
            INSERT INTO documents (key, title, abstract_text, framework, role_heading, kind, is_deprecated)
            VALUES ($key, $title, $abstract, $framework, $rh, $kind, 0)
            """)
        _ = try insert.run(documentParams(key: "swiftui/view", title: "View", abstract: "A view primitive"))
        _ = try insert.run(documentParams(key: "swiftui/stackview", title: "Stack View", abstract: "Arrange views"))

        try db.prepareForDenormServing()

        let params = SearchPagesParams(query: "view", raw: "View", limit: 20)
        return (rows: try db.searchPagesDenormRows(params), framed: try db.searchPagesFramedDenorm(params))
    }

    @Test("row count agrees with the framed §2.5 header")
    func agreesWithFramedRowCount() throws {
        let out = try searchOutputs()
        // Row count agrees with the framed output's [colCount][rowCount] header (LE u32 at offset 4).
        #expect(out.rows.count == framedRowCount(out.framed))
        #expect(out.rows.count == 2, "both seeded docs match 'view'")
    }

    @Test("decodes the §2.3 projection for the exact-title match")
    func decodesExactTitleRow() throws {
        // The exact-title doc sorts first (tier 0: LOWER(title) == LOWER(raw "View")).
        let first = try #require(try searchOutputs().rows.first)
        #expect(first.path == "swiftui/view")
        #expect(first.title == "View")
        #expect(first.framework == "SwiftUI")  // root_display (roots hit)
        #expect(first.rootSlug == "swiftui")
        #expect(first.tier == 0)  // exact title match
        #expect(first.docKind == "symbol")
        #expect(first.rank != nil)  // bm25 populated
    }

    @Test("ranks the non-exact match at a worse tier")
    func ranksLooseMatchWorse() throws {
        // The other match is present, at a higher (worse) tier than the exact hit.
        let match = try searchOutputs().rows.first { $0.path == "swiftui/stackview" }
        let stack = try #require(match)
        #expect(stack.title == "Stack View")
        #expect((stack.tier ?? 0) > 0)
    }
}

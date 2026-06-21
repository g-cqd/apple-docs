// Gate for `searchPagesDenormRows` — the structured ADDB search the cascade port consumes. Proves the
// RowDecoder-based decode of the §2.3 projection produces the expected fields AND that the row COUNT
// agrees with the proven framed `searchPagesFramedDenorm` output (the §2.5 header's rowCount), tying the
// structured path to the byte path.

import ADDB
import ADSQLFullTextSearch
import ADSQLModel
import Foundation
import Testing

@testable import ADSQLSearch
@testable import ADWrite

@Suite("structured ADDB search rows (searchPagesDenormRows)")
struct SearchProjectionRowsTests {

    @Test("decodes the §2.3 projection + agrees with the framed row count")
    func decodesProjectionRows() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("addb-rows-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try Database.open(at: dir.appendingPathComponent("t.adsql").path, options: DatabaseOptions())
        defer { db.close() }
        try migrateSchema(db)
        db.enableFullTextSearch()  // direct-insert seeding fires the FTS trigger (see equivalence test)

        let now = "2026-06-21T00:00:00.000Z"
        _ = try CrawlPersist.upsertRoot(
            db, slug: "swiftui", displayName: "SwiftUI", kind: "framework", source: "apple",
            seedPath: nil, sourceType: nil, now: now)

        let insert = try db.prepare(
            """
            INSERT INTO documents (key, title, abstract_text, framework, role_heading, kind, is_deprecated)
            VALUES ($key, $title, $abstract, $framework, $rh, $kind, 0)
            """)
        func add(key: String, title: String, abstract: String) throws {
            _ = try insert.run([
                "key": .text(key), "title": .text(title), "abstract": .text(abstract),
                "framework": .text("swiftui"), "rh": .text("Protocol"), "kind": .text("symbol")
            ])
        }
        try add(key: "swiftui/view", title: "View", abstract: "A view primitive")
        try add(key: "swiftui/stackview", title: "Stack View", abstract: "Arrange views")

        try db.prepareForDenormServing()

        let params = SearchPagesParams(query: "view", raw: "View", limit: 20)
        let rows = try db.searchPagesDenormRows(params)

        // Row count agrees with the framed output's [colCount][rowCount] header (LE u32 at offset 4).
        let framed = try db.searchPagesFramedDenorm(params)
        let framedRowCount =
            Int(framed[4]) | Int(framed[5]) << 8 | Int(framed[6]) << 16 | Int(framed[7]) << 24
        #expect(rows.count == framedRowCount)
        #expect(rows.count == 2, "both seeded docs match 'view'")

        // The exact-title doc sorts first (tier 0: LOWER(title) == LOWER(raw "View")).
        let first = try #require(rows.first)
        #expect(first.path == "swiftui/view")
        #expect(first.title == "View")
        #expect(first.framework == "SwiftUI")  // root_display (roots hit)
        #expect(first.rootSlug == "swiftui")
        #expect(first.tier == 0)  // exact title match
        #expect(first.docKind == "symbol")
        #expect(first.rank != nil)  // bm25 populated

        // The other match is present, at a higher (worse) tier than the exact hit.
        let stack = try #require(rows.first { $0.path == "swiftui/stackview" })
        #expect(stack.title == "Stack View")
        #expect((stack.tier ?? 0) > 0)
    }
}

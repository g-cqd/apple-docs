// WS-C correctness centerpiece: the restructured rank-only WAND read
// (`searchPagesDenormRows`) must return the SAME §2.3 rows — same docids, same
// `(tier, rank)` order, same tier + rank values — as the score-all oracle
// (`searchPagesDenormRowsScoreAll`, `… ORDER BY tier, rank LIMIT k`) over the real
// schema on ADDB. It seeds a corpus large enough to cross the exact-all threshold
// into the index-set path, and to place the top-k cut inside each tier
// (worstTier 0, 1, and 2/3) across a range of limits — the branches the WAND
// reconstruction takes. Parity here + the SQLite-oracle parity of the score-all
// form (`SearchDenormEquivalenceTests`) chains WAND ⟷ score-all ⟷ SQLite FTS5.

import ADDB
import ADDBFTS
import ADSQLModel
import Foundation
import Testing

@testable import ADSQLSearch

@Suite("search WAND rank restructure vs score-all parity (real schema, ADDB FTS)")
struct SearchWANDRankParityTests {
    /// Seeds `documents` so a `MATCH view` query spans all four tiers with varied
    /// ranks: every doc carries `view` in its abstract (so it matches), and the title
    /// selects the tier — exact (`View`, tier 0), prefix (`Viewport…`, tier 1),
    /// substring (`Nsview…`, tier 2), or none (`Gadget…`, tier 3). The abstract length
    /// varies by index so bm25 orders non-trivially within each tier.
    private func seed(_ db: Database) throws {
        let now = "2026-06-20T00:00:00.000Z"
        _ = try upsertRootAddb(
            db, slug: "swiftui", displayName: "SwiftUI", kind: "framework", source: "apple",
            seedPath: nil, sourceType: nil, now: now)

        let insert = try db.prepare(
            """
            INSERT INTO documents (key, title, abstract_text, framework, role_heading, kind, source_type)
            VALUES ($key, $title, $abstract, 'swiftui', 'Symbol', 'symbol', 'apple-docc')
            """)
        func add(_ key: String, _ title: String, weight: Int) throws {
            // "view" repeated so term-frequency (and thus rank) varies across rows.
            let abstract = String(repeating: "view ", count: weight) + "helper text"
            _ = try insert.run(["key": .text(key), "title": .text(title), "abstract": .text(abstract)])
        }
        for i in 0 ..< 5 { try add("t0/\(i)", "View", weight: 1 + i % 3) }  // tier 0 (exact)
        for i in 0 ..< 10 { try add("t1/\(i)", "Viewport\(i)", weight: 1 + i % 4) }  // tier 1 (prefix)
        for i in 0 ..< 10 { try add("t2/\(i)", "Nsview\(i)", weight: 1 + i % 5) }  // tier 2 (substring)
        for i in 0 ..< 120 { try add("t3/\(i)", "Gadget\(i)", weight: 1 + i % 7) }  // tier 3 (abstract only)
    }

    @Test("WAND path == score-all oracle across limits that cut each tier")
    func wandMatchesScoreAll() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("addb-wandparity-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let db = try Database.open(
            at: dir.appendingPathComponent("t.adsql").path, options: DatabaseOptions())
        defer { db.close() }
        try migrateAddbSchema(db)
        db.enableFullTextSearch()
        try seed(db)
        try db.prepareForDenormServing()

        // 145 matches for "view": < K (1024, so exhausted) but > the exact-all threshold
        // (96) — the index-set path. Limits place the top-k cut inside tier 0 (≤5),
        // tier 1 (≤15), tier 2 (≤25), and tier 3 (>25); plus limit ≥ match count.
        for limit in [1, 3, 5, 8, 15, 24, 25, 26, 50, 145, 200] as [Int64] {
            for raw in ["view", "View"] {  // raw is ASCII-folded, so both drive the same tiers
                let params = SearchPagesParams(query: "view", raw: raw, limit: limit)
                let wand = try db.searchPagesDenormRows(params)
                let oracle = try db.searchPagesDenormRowsScoreAll(params)
                #expect(
                    wand == oracle,
                    "WAND/score-all diverged for limit \(limit) raw \"\(raw)\": wand=\(wand.map(\.path)) oracle=\(oracle.map(\.path))"
                )
            }
        }
    }

    @Test("an active §2.4 filter declines to the score-all path (still identical)")
    func filteredDeclinesToScoreAll() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("addb-wandparity-f-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let db = try Database.open(
            at: dir.appendingPathComponent("t.adsql").path, options: DatabaseOptions())
        defer { db.close() }
        try migrateAddbSchema(db)
        db.enableFullTextSearch()
        try seed(db)
        try db.prepareForDenormServing()

        // A framework filter (and a deprecated-mode filter) is a shape the WAND path
        // declines; it must route to score-all and stay row-identical.
        let cases = [
            SearchPagesParams(query: "view", raw: "view", limit: 25, framework: "swiftui"),
            SearchPagesParams(query: "view", raw: "view", limit: 25, kind: "symbol"),
            SearchPagesParams(query: "view", raw: "view", limit: 25, deprecatedMode: "exclude")
        ]
        for params in cases {
            let wand = try db.searchPagesDenormRows(params)
            let oracle = try db.searchPagesDenormRowsScoreAll(params)
            #expect(wand == oracle, "filtered WAND/score-all diverged")
        }
    }
}

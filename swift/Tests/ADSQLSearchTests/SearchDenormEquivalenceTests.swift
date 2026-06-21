// F3 correctness centerpiece: `searchPagesFramedDenorm` must produce BYTE-IDENTICAL §2.5 output to
// `searchPagesFramed` (the §2.2 normalized form) over the REAL apple-docs schema on ADDB — across a plain
// query, framework / kind / deprecated / year filters, and the tier ordering. This is the proof that the
// 5A read swap (serving the denorm query off a backfilled imported DB) returns the same results as the
// normalized query. Normalized-vs-SQLite-oracle parity is the separate (existing) claim; denorm == oracle
// follows transitively.
//
// Self-contained: migrate the full schema (documents + documents_fts + the AFTER-INSERT trigger that
// indexes it), seed documents whose titles/abstracts carry distinct terms, backfill the denorm columns,
// then assert byte-equality of the two framed forms for each params shape.

import ADDB
import ADSQLFullTextSearch  // enableFullTextSearch() — the test's trigger-based seeding needs FTS first
import ADSQLModel
import Foundation
import Testing

@testable import ADSQLSearch
@testable import ADWrite

@Suite("search denorm vs normalized equivalence (real schema, ADDB FTS)")
struct SearchDenormEquivalenceTests {

    @Test("denorm framing is byte-identical to the normalized query across queries + filters")
    func denormMatchesNormalized() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("addb-searcheq-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let db = try Database.open(at: dir.appendingPathComponent("t.adsql").path, options: DatabaseOptions())
        defer { db.close() }
        try migrateSchema(db)
        // This test SEEDS via direct INSERT, whose AFTER-INSERT trigger writes `documents_fts` — so FTS
        // must be registered before the inserts here. (The real 5A flow imports an already-built DB and
        // calls `prepareForDenormServing()` once after import; no early enable needed there.)
        db.enableFullTextSearch()

        let now = "2026-06-20T00:00:00.000Z"
        _ = try CrawlPersist.upsertRoot(
            db, slug: "swiftui", displayName: "SwiftUI", kind: "framework", source: "apple",
            seedPath: nil, sourceType: nil, now: now)
        _ = try CrawlPersist.upsertRoot(
            db, slug: "uikit", displayName: "UIKit", kind: "framework", source: "apple",
            seedPath: nil, sourceType: nil, now: now)

        // Seed documents: distinct title terms (FTS), varied framework / kind / deprecation / year so the
        // §2.4 filters + the tier CASE actually bite differently across the cases below.
        let insert = try db.prepare(
            """
            INSERT INTO documents
              (key, title, abstract_text, framework, role_heading, kind, is_deprecated, source_type, source_metadata)
            VALUES ($key, $title, $abstract, $framework, $rh, $kind, $dep, $st, $meta)
            """)
        func add(
            key: String, title: String, abstract: String, framework: String, roleHeading: String,
            kind: String, deprecated: Int64, sourceType: String, meta: Value
        ) throws {
            _ = try insert.run([
                "key": .text(key), "title": .text(title), "abstract": .text(abstract),
                "framework": .text(framework), "rh": .text(roleHeading), "kind": .text(kind),
                "dep": .integer(deprecated), "st": .text(sourceType), "meta": meta
            ])
        }
        try add(key: "swiftui/view", title: "View", abstract: "A layout primitive for building interfaces",
            framework: "swiftui", roleHeading: "Protocol", kind: "symbol", deprecated: 0,
            sourceType: "apple-docc", meta: .text(#"{"year":2024}"#))
        try add(key: "swiftui/stack", title: "Stack View layout", abstract: "Arrange views in a stack",
            framework: "swiftui", roleHeading: "Article", kind: "article", deprecated: 0,
            sourceType: "apple-docc", meta: .text(#"{"year":2023}"#))
        try add(key: "uikit/uiview", title: "UIView", abstract: "The view class for interfaces",
            framework: "uikit", roleHeading: "Class", kind: "symbol", deprecated: 0,
            sourceType: "apple-docc", meta: .null)
        try add(key: "uikit/old", title: "Old View thing", abstract: "A deprecated view helper",
            framework: "uikit", roleHeading: "Class", kind: "symbol", deprecated: 1,
            sourceType: "apple-docc", meta: .null)

        // The serving-setup step, exercised through the one-call helper the live wiring uses (it
        // re-registers FTS idempotently + enables JSON + backfills the denorm columns).
        try db.prepareForDenormServing()

        // Each params shape exercises a different slice: plain MATCH + tier; a framework filter; a kind
        // filter; deprecated exclude; a year filter (CAST/json_extract vs the year_num column). For each,
        // the denorm framing must be byte-identical to the normalized framing.
        let cases: [(name: String, params: SearchPagesParams)] = [
            ("plain view", SearchPagesParams(query: "view", raw: "view", limit: 20)),
            ("framework swiftui", SearchPagesParams(query: "view", raw: "view", limit: 20, framework: "swiftui")),
            ("kind symbol", SearchPagesParams(query: "view", raw: "view", limit: 20, kind: "symbol")),
            ("exclude deprecated",
                SearchPagesParams(query: "view", raw: "view", limit: 20, deprecatedMode: "exclude")),
            ("only deprecated",
                SearchPagesParams(query: "view", raw: "view", limit: 20, deprecatedMode: "only")),
            ("year 2024", SearchPagesParams(query: "view", raw: "view", limit: 20, year: 2024)),
            ("exact title tier", SearchPagesParams(query: "view", raw: "View", limit: 20))
        ]
        for (name, params) in cases {
            let normalized = try db.searchPagesFramed(params)
            let denorm = try db.searchPagesFramedDenorm(params)
            #expect(denorm == normalized, "denorm/normalized framing diverged for case: \(name)")
            // Sanity: the query actually returns rows (header is [colCount][rowCount]; rowCount > 0 for
            // the un-filtered cases) so we're comparing non-empty results, not two empty frames.
            if name == "plain view" {
                #expect(normalized.count > 8, "expected non-empty results for the plain query")
            }
        }
    }
}

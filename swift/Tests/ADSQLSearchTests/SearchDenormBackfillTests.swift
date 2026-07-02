// F2 gate: `Database.backfillSearchDenorm()` populates the six v28 denorm columns correctly — the
// preparation step the 5A read swap runs over an imported ADDB DB before serving `denormSQL`.
//
// Self-contained: builds a MINIMAL documents+roots schema inline (the only tables the backfill touches —
// no FTS, no ADWrite migrator, no bun), seeds rows with varied metadata, backfills, then asserts each
// fold — LOWER(title/key), the year extract (present / absent), the track fold (present / absent → ""),
// and the roots join (hit → display_name/slug; miss → framework). These are exactly the SQLite scalars
// `SearchQuery.denormSQL` reads, so a correct backfill makes the denorm query a faithful §2.2 rewrite.
//
// Split into one @Test per seeded row (shared seeding helper, file-scope accessors) to stay inside the
// package's 100 ms type-check budget — the single-body form tripped the hard gate.

import ADDB
import ADSQLModel
import Foundation
import Testing

@testable import ADSQLSearch

private func text(_ row: SQLRow?, _ col: String) -> String? {
    if case .text(let s) = row?[col] { return s }
    return nil
}

private func int(_ row: SQLRow?, _ col: String) -> Int64? {
    if case .integer(let i) = row?[col] { return i }
    return nil
}

private func isNull(_ row: SQLRow?, _ col: String) -> Bool {
    if case .some(.null) = row?[col] { return true }
    return row?[col] == nil
}

@Suite("search-denorm backfill")
struct SearchDenormBackfillTests {
    /// Builds the minimal schema, seeds the three metadata shapes, runs the backfill, and returns
    /// the denorm projection keyed by document key.
    private func backfilledRows() throws -> [String: SQLRow] {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("addb-denorm-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let db = try Database.open(at: dir.appendingPathComponent("t.adsql").path, options: DatabaseOptions())
        defer { db.close() }

        // Minimal schema: just the columns the backfill reads/writes (the real `documents` is a superset).
        _ =
            try db.prepare(
                """
                CREATE TABLE documents (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  key TEXT NOT NULL, title TEXT NOT NULL, framework TEXT, source_metadata TEXT,
                  title_lc TEXT, key_lc TEXT, year_num INTEGER, track_lc TEXT,
                  root_display TEXT, root_slug TEXT
                )
                """
            )
            .run()
        _ = try db.prepare("CREATE TABLE roots (slug TEXT NOT NULL, display_name TEXT)").run()
        _ =
            try db.prepare(
                "INSERT INTO roots (slug, display_name) VALUES ('swiftui', 'SwiftUI')"
            )
            .run()

        let insert = try db.prepare(
            """
            INSERT INTO documents (key, title, framework, source_metadata)
            VALUES ($key, $title, $framework, $meta)
            """)
        func add(key: String, title: String, framework: String, meta: Value) throws {
            _ = try insert.run([
                "key": .text(key), "title": .text(title), "framework": .text(framework), "meta": meta
            ])
        }
        try add(
            key: "SwiftUI/View", title: "View", framework: "swiftui",
            meta: .text(#"{"year":2024,"track":"WWDC"}"#))  // roots hit + year + track
        try add(key: "Other/Thing", title: "Thing", framework: "nomatch", meta: .null)  // miss + no meta
        try add(
            key: "x/Y", title: "ABC", framework: "swiftui",
            meta: .text(#"{"track":"Tooling"}"#))  // hit + track only

        try db.backfillSearchDenorm()

        var byKey: [String: SQLRow] = [:]
        for row
            in try db.prepare(
                "SELECT key, title_lc, key_lc, year_num, track_lc, root_display, root_slug FROM documents"
            )
            .all()
        {
            if case .text(let k) = row["key"] { byKey[k] = row }
        }
        return byKey
    }

    @Test("full metadata row folds title/key/year/track and joins roots")
    func backfillFoldsFullMetadataRow() throws {
        let view = try backfilledRows()["SwiftUI/View"]
        #expect(text(view, "title_lc") == "view")
        #expect(text(view, "key_lc") == "swiftui/view")
        #expect(int(view, "year_num") == 2024)
        #expect(text(view, "track_lc") == "wwdc")
        #expect(text(view, "root_display") == "SwiftUI")  // roots hit → display_name
        #expect(text(view, "root_slug") == "swiftui")  // roots hit → slug (== framework)
    }

    @Test("metadata-less row gets NULL year, empty track, framework fallback")
    func backfillHandlesMetadatalessRow() throws {
        let thing = try backfilledRows()["Other/Thing"]
        #expect(text(thing, "title_lc") == "thing")
        #expect(text(thing, "key_lc") == "other/thing")
        #expect(isNull(thing, "year_num"))  // no metadata → NULL year
        #expect(text(thing, "track_lc") == "")  // absent track folds to "" (never NULL)
        #expect(text(thing, "root_display") == "nomatch")  // roots miss → framework fallback
        #expect(text(thing, "root_slug") == "nomatch")
    }

    @Test("track-only metadata row folds track, keeps year NULL, joins roots")
    func backfillHandlesTrackOnlyRow() throws {
        let abc = try backfilledRows()["x/Y"]
        #expect(text(abc, "title_lc") == "abc")
        #expect(text(abc, "key_lc") == "x/y")
        #expect(isNull(abc, "year_num"))  // track-only metadata → NULL year
        #expect(text(abc, "track_lc") == "tooling")
        #expect(text(abc, "root_display") == "SwiftUI")
        #expect(text(abc, "root_slug") == "swiftui")
    }
}

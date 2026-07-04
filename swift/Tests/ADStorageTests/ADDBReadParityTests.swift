// BUG-REPORTS B10(c) — the read-swap parity gate.
//
// Proves that `StorageConnection`'s read verbs produce IDENTICAL output whether
// the corpus is a libsqlite3 `.db` or a native ADDB snapshot. The harness:
//   1. builds a small apple-docs-shaped SQLite corpus (raw libsqlite3, the same
//      dlopen'd lib the read path uses);
//   2. imports it into a fresh ADDB database via `ADDBImport.importSQLite`
//      (documents_fts reconstruction + the v28 denorm columns);
//   3. opens BOTH with `StorageConnection` — format detection routes one to the
//      SQLite backend and one to the ADDB backend;
//   4. runs `search` (5 probes), `read`, `status`, `browse` on each and asserts
//      the results are byte-identical (search `rank` is the bm25 double, agreed
//      to 1e-9 relative between the two FTS engines — every other cell, and the
//      full row order, is exact).

import ADDB
import ADDBImport
import ADSQLModel
import Foundation
import Testing

@testable import ADStorage

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

@Suite(.serialized)
struct ADDBReadParityTests {
    // MARK: - fixtures

    /// Opens both backends over the SAME logical corpus and hands them to `body`.
    /// The SQLite corpus is built once; the ADDB corpus is imported from it.
    private func withBothBackends(_ body: (_ sqlite: StorageConnection, _ addb: StorageConnection) throws -> Void)
        throws
    {
        let dir = "/tmp/adstorage-parity-\(UInt64.random(in: 0 ..< .max))"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let sqlitePath = dir + "/corpus.db"
        let addbPath = dir + "/corpus.adsql"

        try Corpus.buildSQLite(at: sqlitePath)
        try Corpus.importToADDB(from: sqlitePath, at: addbPath)

        let sqlite = try #require(StorageConnection(path: sqlitePath), "open SQLite corpus")
        let addb = try #require(StorageConnection(path: addbPath), "open ADDB corpus")

        // Confirm the two paths really are different backends (else the diff is vacuous).
        #expect(sqlite.conn is SQLiteConnection, "SQLite corpus should select the libsqlite3 backend")
        #expect(addb.conn is ADDBBackend, "ADDB corpus should select the native backend")

        try body(sqlite, addb)
    }

    // MARK: - search (5 probes)

    /// The B0/spike probes: (fts MATCH query, raw term).
    private static let probes: [(query: String, raw: String)] = [
        ("view", "View"),
        ("button", "Button"),
        ("async await", "async await"),
        ("urlsession", "URLSession"),
        ("navigation stack", "navigation stack")
    ]

    @Test func searchProbesAreByteIdenticalAcrossBackends() throws {
        try withBothBackends { sqlite, addb in
            for probe in Self.probes {
                let params = searchParams(query: probe.query, raw: probe.raw)

                // The framed §2.5 packed payload (SQLite: searchPagesSQL.run; ADDB: searchPagesFramedDenorm).
                let a = try #require(sqlite.conn.searchPagesFramed(params), "sqlite framed '\(probe.query)'")
                let b = try #require(addb.conn.searchPagesFramed(params), "addb framed '\(probe.query)'")
                assertFramedEqual(a, b, probe: probe.query)

                // The public JSON path (SQLite: runJSON; ADDB: denorm rows framed as JSON).
                let ja = try #require(sqlite.searchPagesJSON(params), "sqlite json '\(probe.query)'")
                let jb = try #require(addb.searchPagesJSON(params), "addb json '\(probe.query)'")
                assertSearchJSONEqual(ja, jb, probe: probe.query)
            }
        }
    }

    // MARK: - read (a known path)

    @Test func readIsIdenticalAcrossBackends() throws {
        try withBothBackends { sqlite, addb in
            for path in ["doc/swiftui/view", "doc/foundation/urlsession", "doc/swiftui/navigationstack"] {
                let a = readRecordString(sqlite, path: path)
                let b = readRecordString(addb, path: path)
                #expect(a == b, "read('\(path)') diverged\n--- sqlite ---\n\(a)\n--- addb ---\n\(b)")
            }
            // searchByTitle (the symbol resolution path read_doc also uses).
            #expect(
                titleString(sqlite, "URLSession", framework: nil) == titleString(addb, "URLSession", framework: nil),
                "searchByTitle('URLSession') diverged")
            // snapshotTier.
            #expect(sqlite.snapshotTier() == addb.snapshotTier(), "snapshotTier diverged")
        }
    }

    // MARK: - status

    @Test func statusIsIdenticalAcrossBackends() throws {
        try withBothBackends { sqlite, addb in
            let a = statusString(sqlite)
            let b = statusString(addb)
            #expect(a == b, "status diverged\n--- sqlite ---\n\(a)\n--- addb ---\n\(b)")
        }
    }

    // MARK: - freshness (MAX aggregate)

    /// `staleRootRows()` (the freshness helper) runs `SELECT root_slug, MAX(timestamp) … GROUP BY
    /// root_slug`. It was formerly the ONE read-path dialect gap — the ADDB engine implemented only
    /// COUNT/SUM, so the `MAX(timestamp)` query degraded to `[]`. ADDB now implements MAX/MIN/AVG,
    /// so both backends return the same per-root last-update rows (also folded into `statusString`).
    @Test func staleRootRowsMatchesAcrossBackends() throws {
        try withBothBackends { sqlite, addb in
            let a = sqlite.staleRootRows()
            #expect(!a.isEmpty, "SQLite should return per-root freshness rows")
            #expect(
                staleString(a) == staleString(addb.staleRootRows()),
                "staleRootRows diverged:\nsqlite \(staleString(a))\naddb   \(staleString(addb.staleRootRows()))")
        }
    }

    // MARK: - browse

    @Test func browseIsIdenticalAcrossBackends() throws {
        try withBothBackends { sqlite, addb in
            for slug in ["swiftui", "foundation", "SwiftUI", "combine"] {
                #expect(
                    rootString(sqlite, slug) == rootString(addb, slug),
                    "resolveRoot('\(slug)') diverged")
            }
            for slug in ["swiftui", "foundation"] {
                #expect(
                    pagesString(sqlite, slug) == pagesString(addb, slug),
                    "pagesByRoot('\(slug)') diverged")
            }
            for path in ["doc/swiftui/view", "doc/swiftui/collection"] {
                #expect(
                    browsePageString(sqlite, path) == browsePageString(addb, path),
                    "browsePage('\(path)') diverged")
                #expect(
                    childrenString(sqlite, path) == childrenString(addb, path),
                    "documentChildren('\(path)') diverged")
            }
        }
    }

    // MARK: - helpers

    private func searchParams(query: String, raw: String) -> SearchPagesParams {
        SearchPagesParams(
            query: query, raw: raw, limit: 25, framework: nil, sourceType: nil, sourcesJson: nil,
            kind: nil, language: nil, year: nil, trackLike: nil, deprecatedMode: "include",
            minIos: nil, minMacos: nil, minWatchos: nil, minTvos: nil, minVisionos: nil)
    }

    /// Decodes both framed payloads and compares them cell-by-cell: exact for
    /// every cell except the bm25 `rank` (column 22), which is compared to 1e-9
    /// relative. Row order + row/column counts are exact.
    private func assertFramedEqual(_ a: [UInt8], _ b: [UInt8], probe: String) {
        let da = FramedRows(a)
        let db = FramedRows(b)
        #expect(da.columnCount == db.columnCount, "[\(probe)] colCount \(da.columnCount) vs \(db.columnCount)")
        #expect(da.rows.count == db.rows.count, "[\(probe)] rowCount \(da.rows.count) vs \(db.rows.count)")
        #expect(!da.rows.isEmpty, "[\(probe)] returned no rows (probe should hit the corpus)")
        let rankColumn = 22
        for (i, (ra, rb)) in zip(da.rows, db.rows).enumerated() {
            for col in 0 ..< min(ra.count, rb.count) {
                if col == rankColumn {
                    let x = ra[col].double ?? .nan
                    let y = rb[col].double ?? .nan
                    #expect(
                        abs(x - y) <= 1e-9 * Swift.max(abs(y), 1),
                        "[\(probe)] row \(i) rank \(x) vs \(y)")
                } else {
                    #expect(ra[col] == rb[col], "[\(probe)] row \(i) col \(col): \(ra[col]) vs \(rb[col])")
                }
            }
        }
    }

    /// Compares the two JSON search payloads: identical up to the `"rank":<double>`
    /// substrings (the bm25 value differs in the low bits between engines).
    private func assertSearchJSONEqual(_ a: [UInt8], _ b: [UInt8], probe: String) {
        let sa = maskRank(String(decoding: a, as: UTF8.self))
        let sb = maskRank(String(decoding: b, as: UTF8.self))
        #expect(sa == sb, "[\(probe)] search JSON diverged (rank-masked)\n--- sqlite ---\n\(sa)\n--- addb ---\n\(sb)")
    }

    /// Replaces each `"rank":<number>` with `"rank":#` so the structural JSON is
    /// compared exactly while the bm25 double is compared separately (framed).
    private func maskRank(_ s: String) -> String {
        var out = ""
        var i = s.startIndex
        let needle = "\"rank\":"
        while i < s.endIndex {
            if s[i...].hasPrefix(needle) {
                out += needle + "#"
                i = s.index(i, offsetBy: needle.count)
                // skip the numeric token (digits, sign, '.', 'e', 'E')
                while i < s.endIndex, "0123456789+-.eE".contains(s[i]) { i = s.index(after: i) }
            } else {
                out.append(s[i])
                i = s.index(after: i)
            }
        }
        return out
    }

    // MARK: canonical serializers (deterministic; byte-compared across backends)

    private func readRecordString(_ c: StorageConnection, path: String) -> String {
        guard let r = c.readDocument(path) else { return "MISS \(path)" }
        var s = "REC key=\(r.path) title=\(opt(r.title)) fwDisplay=\(opt(r.frameworkDisplay)) fw=\(opt(r.framework)) "
        s += "root=\(opt(r.rootSlug)) role=\(opt(r.role)) roleHeading=\(opt(r.roleHeading)) kind=\(opt(r.kind)) "
        s += "abstract=\(opt(r.abstract)) platforms=\(opt(r.platformsJSON)) decl=\(opt(r.declaration)) "
        s += "dep=\(r.isDeprecated) beta=\(r.isBeta)\n"
        s += "TIER \(opt(c.snapshotTier()))\n"
        for sec in c.documentSections(path) {
            s += "SEC kind=\(opt(sec.sectionKind)) heading=\(opt(sec.heading)) text=\(opt(sec.contentText)) "
            s += "json=\(opt(sec.contentJSON)) sort=\(sec.sortOrder)\n"
        }
        for rel in c.relationshipCountsByType(path) {
            s += "REL \(rel.relationType)=\(rel.count)\n"
        }
        return s
    }

    private func titleString(_ c: StorageConnection, _ title: String, framework: String?) -> String {
        guard let r = c.searchByTitle(title, framework: framework) else { return "MISS" }
        return "TITLE key=\(r.path) title=\(opt(r.title)) kind=\(opt(r.kind)) role=\(opt(r.role))"
    }

    private func statusString(_ c: StorageConnection) -> String {
        let st = c.corpusStats()
        var s = "pages=\(st.totalPages) deleted=\(st.totalDeleted) roots=\(st.totalRoots)\n"
        for k in st.rootsByKind { s += "byKind \(opt(k.kind))=\(k.count)\n" }
        if let l = st.lastLog { s += "lastLog \(opt(l.timestamp)) \(opt(l.action))\n" }
        if let a = st.activity {
            s +=
                "activity \(opt(a.action)) \(opt(a.startedAt)) pid=\(a.pid.map { "\($0)" } ?? "nil") roots=\(opt(a.rootsJSON))\n"
        }
        let p = st.crawlProgress
        s += "crawl pending=\(p.pending) processed=\(p.processed) failed=\(p.failed) total=\(p.total)\n"
        for r in st.crawlByRoot {
            s += "crawlRoot \(opt(r.rootSlug)) p=\(r.pending) pr=\(r.processed) f=\(r.failed)\n"
        }
        s += "snapshotTag=\(opt(c.getSnapshotMeta("snapshot_tag")))\n"
        s += "hasBodyIndex=\(c.hasBodyIndex()) hasSections=\(c.hasTable("document_sections"))\n"
        s += staleString(c.staleRootRows())  // MAX(timestamp) — implemented on both backends
        return s
    }

    /// `staleRootRows()` serialized in slug order (GROUP BY leaves the order engine-defined, so
    /// sort before comparing) — one `stale <slug>=<lastUpdate>` line per root.
    private func staleString(_ rows: [(slug: String, lastUpdate: String)]) -> String {
        rows.sorted { $0.slug < $1.slug }.map { "stale \($0.slug)=\($0.lastUpdate)\n" }.joined()
    }

    private func rootString(_ c: StorageConnection, _ slug: String) -> String {
        guard let r = c.resolveRoot(slug) else { return "MISS \(slug)" }
        return "ROOT slug=\(r.slug) name=\(r.displayName) kind=\(r.kind) src=\(r.sourceType)"
    }

    private func pagesString(_ c: StorageConnection, _ slug: String) -> String {
        c.pagesByRoot(slug)
            .map { "PAGE \($0.path) \(opt($0.title)) \(opt($0.role)) \(opt($0.roleHeading)) \(opt($0.abstract))" }
            .joined(separator: "\n")
    }

    private func browsePageString(_ c: StorageConnection, _ path: String) -> String {
        guard let p = c.browsePage(path) else { return "MISS \(path)" }
        return "BP \(p.path) \(opt(p.title))"
    }

    private func childrenString(_ c: StorageConnection, _ path: String) -> String {
        c.documentChildren(path).map { "CHILD \($0.targetPath) \(opt($0.title)) \(opt($0.section))" }
            .joined(separator: "\n")
    }

    private func opt(_ s: String?) -> String { s ?? "∅" }
    private func opt(_ v: Int64?) -> String { v.map { "\($0)" } ?? "∅" }
    private func opt(_ v: Double?) -> String { v.map { "\($0)" } ?? "∅" }
}

// MARK: - framed-payload decoder (for the search cell diff)

private struct FramedRows {
    enum Cell: Equatable, CustomStringConvertible {
        case null
        case int(Int64)
        case real(Double)
        case text(String)
        case blob([UInt8])
        var description: String {
            switch self {
                case .null: return "null"
                case .int(let i): return "int(\(i))"
                case .real(let d): return "real(\(d))"
                case .text(let s): return "text(\(s))"
                case .blob(let b): return "blob(\(b.count)B)"
            }
        }
        var double: Double? {
            switch self {
                case .real(let d): return d
                case .int(let i): return Double(i)
                default: return nil
            }
        }
    }

    let columnCount: Int
    let rows: [[Cell]]

    init(_ bytes: [UInt8]) {
        var off = 0
        func u32() -> UInt32 {
            let v =
                UInt32(bytes[off]) | UInt32(bytes[off + 1]) << 8 | UInt32(bytes[off + 2]) << 16
                | UInt32(bytes[off + 3]) << 24
            off += 4
            return v
        }
        func i64() -> Int64 {
            var v: UInt64 = 0
            for i in 0 ..< 8 { v |= UInt64(bytes[off + i]) << (8 * i) }
            off += 8
            return Int64(bitPattern: v)
        }
        let columns = Int(u32())
        let rowCount = Int(u32())
        var out: [[Cell]] = []
        for _ in 0 ..< rowCount {
            var row: [Cell] = []
            for _ in 0 ..< columns {
                let tag = bytes[off]
                off += 1
                switch tag {
                    case 0: row.append(.null)
                    case 1: row.append(.int(i64()))
                    case 2: row.append(.real(Double(bitPattern: UInt64(bitPattern: i64()))))
                    case 3:
                        let n = Int(u32())
                        row.append(.text(String(decoding: bytes[off ..< off + n], as: UTF8.self)))
                        off += n
                    case 4:
                        let n = Int(u32())
                        row.append(.blob(Array(bytes[off ..< off + n])))
                        off += n
                    default: row.append(.null)
                }
            }
            out.append(row)
        }
        self.columnCount = columns
        self.rows = out
    }
}

// Hidden spike verb for WS-B's B0 HARD GATE (RFC 0001 p5/G3 §1):
//
//   ad-cli _addb-read-spike --db <sqlite> --snapshot <adsql> [--iterations N]
//
// Measures the denormalized FTS search read through BOTH backends over the
// SAME real corpus:
//   (a) ADDB in-process — `Database.searchPagesDenormRows` (ADSQLSearch), over
//       a snapshot produced by ADDBImport's `importSQLite` (documents + roots
//       + the reconstructed `documents_fts` + the v28 denorm columns);
//   (b) libsqlite3 — `StorageConnection.ftsRows` (the shipping read path).
//
// Prints the per-probe latency distributions (p50/p95/mean over N alternating
// iterations after warmup) and the aggregate GO/NO-GO verdict per the gate:
// GO iff ADDB p50 < 0.97 × SQLite p50 AND ADDB p95 ≤ SQLite p95.
//
// The snapshot import runs once (the verb reuses an existing --snapshot); the
// LIVE corpus is only ever READ.

import ADDB
import ADDBFTS
import ADDBImport
import ADDBJSON
import ADSQLSearch
import ADStorage
import ArgumentParser
import Foundation

struct AddbReadSpikeCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "_addb-read-spike",
        abstract: "WS-B B0 gate: ADDB in-process FTS read vs libsqlite3 (spike).",
        shouldDisplay: false)

    @Option(name: .long, help: "The live SQLite corpus (read-only source).")
    var db: String

    @Option(name: .long, help: "The ADDB snapshot path (imported on first run, reused after).")
    var snapshot: String

    @Option(name: .long, help: "Timed iterations per backend per probe.")
    var iterations: Int = 200

    @Option(name: .long, help: "Warmup iterations per backend per probe (untimed).")
    var warmup: Int = 20

    @Option(name: .long, help: "Search LIMIT bound per query.")
    var limit: Int = 25

    /// (fts MATCH query, raw term) probes — real corpus-shaped terms across
    /// broad/narrow/multi-term/stemmed shapes.
    private static let probes: [(query: String, raw: String)] = [
        ("view", "View"),
        ("button", "Button"),
        ("async await", "async await"),
        ("urlsession", "URLSession"),
        ("navigation stack", "navigation stack"),
    ]

    func run() throws {
        // ── the libsqlite3 side FIRST: a READWRITE (query_only) open performs
        // WAL-index recovery/attach, after which the importer's READONLY
        // SQLiteSource can open the same file (a cold readonly open of a WAL db
        // needing recovery fails with 'unable to open database file').
        guard let connection = StorageConnection(path: db) else {
            throw ValidationError("cannot open \(db)")
        }

        // ── the ADDB snapshot (import once) ──────────────────────────────────
        let fresh = !FileManager.default.fileExists(atPath: snapshot)
        let database: Database
        do {
            database = try Database.open(at: snapshot, options: DatabaseOptions())
        } catch {
            throw ValidationError("cannot open ADDB snapshot at \(snapshot): \(error)")
        }
        defer { database.close() }
        database.enableFullTextSearch()
        database.enableJSON()

        if fresh {
            FileHandle.standardError.write(Data("spike: importing \(db) → \(snapshot)…\n".utf8))
            let started = ContinuousClock.now
            do {
                _ = try database.importSQLite(
                    from: db, manifest: Self.importManifest(sourceDb: db), batchSize: 10_000)
            } catch {
                throw ValidationError("importSQLite failed: \(error)")
            }
            let elapsed = ContinuousClock.now - started
            FileHandle.standardError.write(Data("spike: import done in \(elapsed)\n".utf8))
        }

        // ── measure ─────────────────────────────────────────────────────────
        print("ADDB read spike — \(iterations) iterations/backend/probe (warmup \(warmup)), limit \(limit)")
        print("snapshot: \(snapshot) (fresh: \(fresh))")
        print("")

        var goAll = true
        var pooledAddb: [Double] = []
        var pooledSqlite: [Double] = []

        for probe in Self.probes {
            let addbParams = ADSQLSearch.SearchPagesParams(
                query: probe.query, raw: probe.raw, limit: Int64(limit))
            let sqliteParams = ADStorage.SearchPagesParams(
                query: probe.query, raw: probe.raw, limit: Int64(limit), framework: nil,
                sourceType: nil, sourcesJson: nil, kind: nil, language: nil, year: nil,
                trackLike: nil, deprecatedMode: "include", minIos: nil, minMacos: nil,
                minWatchos: nil, minTvos: nil, minVisionos: nil)

            // Sanity: both backends see the same row count for the probe.
            let addbCount = try addbRows(database, addbParams).count
            let sqliteCount = connection.ftsRows(sqliteParams)?.count ?? -1
            let countNote = addbCount == sqliteCount ? "" : "  [COUNT MISMATCH]"

            for _ in 0..<warmup {
                _ = try addbRows(database, addbParams)
                _ = connection.ftsRows(sqliteParams)
            }

            var addbTimes: [Double] = []
            var sqliteTimes: [Double] = []
            addbTimes.reserveCapacity(iterations)
            sqliteTimes.reserveCapacity(iterations)
            for _ in 0..<iterations {
                // Alternate per iteration so cache drift is shared fairly.
                let t0 = ContinuousClock.now
                _ = try addbRows(database, addbParams)
                addbTimes.append(microseconds(since: t0))
                let t1 = ContinuousClock.now
                _ = connection.ftsRows(sqliteParams)
                sqliteTimes.append(microseconds(since: t1))
            }
            pooledAddb.append(contentsOf: addbTimes)
            pooledSqlite.append(contentsOf: sqliteTimes)

            let a = Stats(addbTimes)
            let s = Stats(sqliteTimes)
            let go = a.p50 < 0.97 * s.p50 && a.p95 <= s.p95
            goAll = goAll && go
            print("probe \"\(probe.query)\" (rows \(addbCount))\(countNote)")
            print("  addb   p50 \(fmt(a.p50))µs  p95 \(fmt(a.p95))µs  mean \(fmt(a.mean))µs")
            print("  sqlite p50 \(fmt(s.p50))µs  p95 \(fmt(s.p95))µs  mean \(fmt(s.mean))µs")
            print("  → \(go ? "GO" : "NO-GO") (p50 ratio \(fmt(a.p50 / s.p50)), p95 ratio \(fmt(a.p95 / s.p95)))")
            print("")
        }

        let pa = Stats(pooledAddb)
        let ps = Stats(pooledSqlite)
        let pooledGo = pa.p50 < 0.97 * ps.p50 && pa.p95 <= ps.p95
        print("POOLED  addb p50 \(fmt(pa.p50))µs p95 \(fmt(pa.p95))µs · sqlite p50 \(fmt(ps.p50))µs p95 \(fmt(ps.p95))µs")
        print("GATE (pooled): \(pooledGo ? "GO" : "NO-GO") — ADDB p50 \(fmt(pa.p50 / ps.p50))× / p95 \(fmt(pa.p95 / ps.p95))× of SQLite")
        print("GATE (every probe): \(goAll ? "GO" : "NO-GO")")
    }

    private func addbRows(_ database: Database, _ params: ADSQLSearch.SearchPagesParams) throws
        -> [SearchProjectionRow]
    {
        do {
            return try database.searchPagesDenormRows(params)
        } catch {
            throw ValidationError("searchPagesDenormRows failed: \(error)")
        }
    }

    private func microseconds(since start: ContinuousClock.Instant) -> Double {
        let duration = ContinuousClock.now - start
        let (seconds, attoseconds) = duration.components
        return Double(seconds) * 1_000_000 + Double(attoseconds) / 1e12
    }

    private func fmt(_ value: Double) -> String {
        String(format: "%.1f", value)
    }

    /// The B0 import manifest: ONLY `documents` + `roots` (+ the reconstructed
    /// `documents_fts` and the v28 denorm columns). Every other source table is
    /// skipped by enumeration — the read under test touches nothing else, and
    /// skipping `document_sections`/vectors keeps the one-time import bounded.
    private static func importManifest(sourceDb: String) throws -> ImportManifest {
        guard let connection = StorageConnection(path: sourceDb) else {
            throw ValidationError("cannot open \(sourceDb) to enumerate tables")
        }
        let keep: Set<String> = ["documents", "roots"]
        let skip = connection.allTableNames().filter { !keep.contains($0) }

        return ImportManifest(
            ftsTables: [
                .init(
                    name: "documents_fts",
                    columns: ["title", "abstract", "declaration", "headings", "key"],
                    tokenize: ["porter", "unicode61"],
                    source: .init(
                        table: "documents",
                        columns: ["title", "abstract_text", "declaration_text", "headings", "key"]))
            ],
            skipTables: skip,
            denorm: [
                ImportManifest.Denorm(
                    table: "documents",
                    columns: [
                        .init(name: "title_lc", type: .text, valueSQL: "LOWER(title)"),
                        .init(name: "key_lc", type: .text, valueSQL: "LOWER(key)"),
                        .init(
                            name: "year_num", type: .integer,
                            valueSQL: "CAST(json_extract(source_metadata, '$.year') AS INTEGER)"),
                        .init(
                            name: "track_lc", type: .text,
                            valueSQL: "LOWER(COALESCE(json_extract(source_metadata, '$.track'), ''))"),
                        .init(name: "root_slug", type: .text, valueSQL: "framework"),
                    ],
                    lookups: [
                        .init(
                            name: "root_display", type: .text, matchColumn: "framework",
                            lookupTable: "roots", lookupKey: "slug", lookupValue: "display_name",
                            fallbackColumn: "framework")
                    ])
            ])
    }
}

/// p50/p95/mean over a sample (µs).
private struct Stats {
    let p50: Double
    let p95: Double
    let mean: Double
    init(_ samples: [Double]) {
        let sorted = samples.sorted()
        guard !sorted.isEmpty else {
            p50 = 0
            p95 = 0
            mean = 0
            return
        }
        p50 = sorted[sorted.count / 2]
        p95 = sorted[Int(Double(sorted.count - 1) * 0.95)]
        mean = sorted.reduce(0, +) / Double(sorted.count)
    }
}

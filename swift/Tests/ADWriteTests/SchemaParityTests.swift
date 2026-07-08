// The apple-docs SCHEMA PARITY gate — the storage pivot's proof.
//
// Runs the NATIVE migration ladder (`ADWrite.migrateSchema` — the verbatim JS
// migrations v1…v27 on REAL SQLite) against a fresh file, introspects the result
// through the SAME `sqlite_master` / `PRAGMA table_info` projection the bun
// fixture-capture script uses, and asserts the catalog EQUALS the committed
// JS-migrated reference (`Fixtures/js-sqlite-catalog.json`) EXACTLY: same tables
// (each with the same columns: name + type + notnull + default + rowid-alias PK),
// same indexes (incl. the implied unique auto-indexes and their numbering, and
// the partial `idx_sf_symbols_codepoint`), same triggers, same FTS virtual
// tables. Both engines are SQLite now, so there are NO representational deltas —
// any mismatch is a real ladder divergence and fails with a precise diff.

import ADStorage
import Foundation
import Testing

@testable import ADWrite

@Suite("apple-docs schema parity (native SQLite ladder vs the committed JS SQLite reference)")
struct SchemaParityTests {
    /// The JS-migrated SQLite catalog, captured ONCE from the Bun `bun:sqlite` migrations (see
    /// `captureReferenceFixture`) and frozen here as the parity reference — so the gate runs with no `bun`
    /// or `src/` dependency. Read from the source tree via `#filePath` (like ADEmbedTests' fixtures).
    static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().appendingPathComponent("Fixtures/js-sqlite-catalog.json")

    @Test("native SQLite catalog matches the committed JS SQLite reference exactly")
    func nativeCatalogMatchesReference() throws {
        // ── Native catalog: fresh file + the production migration ladder ──────
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("sqlite-parity-native-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let (native, outcome) = try NativeCatalogExtractor.build(inDirectory: tmpDir.path)
        // The ladder must land on the JS terminal version (SCHEMA_VERSION = 27).
        #expect(outcome.finalVersion == AppleDocsSchema.latestVersion)
        #expect(outcome.startingVersion == 0)

        // ── Committed JS SQLite reference (no bun) ────────────────────────────
        let reference = try JSONDecoder()
            .decode(
                CatalogModel.self, from: Data(contentsOf: Self.fixtureURL))

        // ── Diff ─────────────────────────────────────────────────────────────
        let report = SchemaDiff.compare(native: native, reference: reference)
        print(report.render())
        #expect(report.isMatch, "schema parity mismatch — see the printed diff above")
    }

    @Test("re-running the ladder on an up-to-date catalog is a no-op")
    func migrateIsIdempotent() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("sqlite-parity-idem-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let connection = try SQLiteWriteConnection(path: tmpDir.path + "/idem.db")
        defer { connection.close() }
        let first = try migrateSchema(connection)
        #expect(first.appliedCount == AppleDocsSchema.latestVersion)

        let second = try migrateSchema(connection)
        #expect(second.appliedCount == 0)
        #expect(second.startingVersion == AppleDocsSchema.latestVersion)
        #expect(second.finalVersion == AppleDocsSchema.latestVersion)

        // The apple-docs schema_meta row carries the terminal version (the JS
        // runner's INSERT OR REPLACE).
        let stored = try connection.get(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'")?
            .text("value")
        #expect(stored == String(AppleDocsSchema.latestVersion))
    }

    /// Regenerates `Fixtures/js-sqlite-catalog.json` from the live Bun `bun:sqlite` migrations. Disabled by
    /// default; run explicitly with `AD_CAPTURE_SCHEMA_FIXTURE=1` (needs `bun` + `src/storage/database.js`)
    /// when the JS schema changes. NOT a gate — the frozen fixture is what `nativeCatalogMatchesReference`
    /// compares against.
    @Test(
        "capture the JS SQLite reference fixture (regeneration tool, off by default)",
        .enabled(
            if: SQLiteReferenceExtractor.bunAvailable
                && ProcessInfo.processInfo.environment["AD_CAPTURE_SCHEMA_FIXTURE"] != nil,
            "set AD_CAPTURE_SCHEMA_FIXTURE=1 (with bun on PATH) to regenerate"))
    func captureReferenceFixture() throws {
        let reference = try SQLiteReferenceExtractor.build()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(reference).write(to: Self.fixtureURL)
        print("captured JS SQLite reference → \(Self.fixtureURL.path)")
    }
}

/// A structural diff of two ``CatalogModel``s, rendered as a human-readable report.
enum SchemaDiff {
    struct Report {
        var tableOnlyInNative: [String] = []
        var tableOnlyInReference: [String] = []
        var columnDiffs: [String] = []  // per-table column mismatches
        var rowidAliasDiffs: [String] = []
        var indexOnlyInNative: [String] = []
        var indexOnlyInReference: [String] = []
        var indexDiffs: [String] = []
        var ftsOnlyInNative: [String] = []
        var ftsOnlyInReference: [String] = []
        var ftsDiffs: [String] = []
        var triggerOnlyInNative: [String] = []
        var triggerOnlyInReference: [String] = []
        var triggerDiffs: [String] = []

        // Counts for the summary line (filled by `compare`).
        var nativeCounts = (tables: 0, indexes: 0, fts: 0, triggers: 0)
        var referenceCounts = (tables: 0, indexes: 0, fts: 0, triggers: 0)

        var isMatch: Bool {
            tableOnlyInNative.isEmpty && tableOnlyInReference.isEmpty
                && columnDiffs.isEmpty && rowidAliasDiffs.isEmpty
                && indexOnlyInNative.isEmpty && indexOnlyInReference.isEmpty && indexDiffs.isEmpty
                && ftsOnlyInNative.isEmpty && ftsOnlyInReference.isEmpty && ftsDiffs.isEmpty
                && triggerOnlyInNative.isEmpty && triggerOnlyInReference.isEmpty && triggerDiffs.isEmpty
        }

        func render() -> String {
            var lines: [String] = []
            lines.append("══════════════════════════════════════════════════════════════════════")
            lines.append("apple-docs SCHEMA PARITY — native SQLite ladder vs JS SQLite reference")
            lines.append("══════════════════════════════════════════════════════════════════════")
            lines.append(
                "native    : \(nativeCounts.tables) tables, \(nativeCounts.indexes) indexes, "
                    + "\(nativeCounts.fts) FTS, \(nativeCounts.triggers) triggers")
            lines.append(
                "reference : \(referenceCounts.tables) tables, \(referenceCounts.indexes) indexes, "
                    + "\(referenceCounts.fts) FTS, \(referenceCounts.triggers) triggers")
            lines.append("")

            func section(_ title: String, _ entries: [String]) {
                guard !entries.isEmpty else { return }
                lines.append("── \(title) (\(entries.count)) ──")
                for entry in entries { lines.append("  \(entry)") }
                lines.append("")
            }
            section("TABLES only in native", tableOnlyInNative)
            section("TABLES only in reference", tableOnlyInReference)
            section("COLUMN mismatches", columnDiffs)
            section("PRIMARY-KEY (rowid alias) mismatches", rowidAliasDiffs)
            section("INDEXES only in native", indexOnlyInNative)
            section("INDEXES only in reference", indexOnlyInReference)
            section("INDEX mismatches", indexDiffs)
            section("FTS only in native", ftsOnlyInNative)
            section("FTS only in reference", ftsOnlyInReference)
            section("FTS mismatches", ftsDiffs)
            section("TRIGGERS only in native", triggerOnlyInNative)
            section("TRIGGERS only in reference", triggerOnlyInReference)
            section("TRIGGER mismatches", triggerDiffs)

            if isMatch {
                lines.append("RESULT: ✅ FULL MATCH")
                lines.append("")
                lines.append("Both sides are real SQLite projected through ONE introspection (the")
                lines.append("fixture-capture manifest grammar + SQLiteReferenceExtractor.parse), so")
                lines.append("the comparison carries no cross-engine normalization: every table,")
                lines.append("column (name/type/notnull/default/rowid-alias), index (explicit AND")
                lines.append("implied autoindex, with numbering; partial predicate preserved by the")
                lines.append("index_list projection), trigger, and FTS5 config matches the JS catalog.")
            } else {
                lines.append("RESULT: ❌ MISMATCH")
            }
            lines.append("══════════════════════════════════════════════════════════════════════")
            return lines.joined(separator: "\n")
        }
    }

    // swiftlint:disable:next function_body_length  // one sequential table/index/fts/trigger diff pass
    static func compare(native: CatalogModel, reference: CatalogModel) -> Report {
        var report = Report()
        report.nativeCounts = (
            native.tables.count, native.indexes.count, native.fts.count, native.triggers.count
        )
        report.referenceCounts = (
            reference.tables.count, reference.indexes.count, reference.fts.count,
            reference.triggers.count
        )

        // Tables + columns.
        let nativeTableNames = Set(native.tables.keys)
        let refTableNames = Set(reference.tables.keys)
        report.tableOnlyInNative = nativeTableNames.subtracting(refTableNames).sorted()
        report.tableOnlyInReference = refTableNames.subtracting(nativeTableNames).sorted()

        for name in nativeTableNames.intersection(refTableNames).sorted() {
            let nativeTable = native.tables[name]!
            let refTable = reference.tables[name]!
            if nativeTable.columns != refTable.columns {
                report.columnDiffs.append(
                    columnDiffDescription(table: name, native: nativeTable, reference: refTable))
            }
            if nativeTable.rowidAlias != refTable.rowidAlias {
                report.rowidAliasDiffs.append(
                    "\(name): native=\(nativeTable.rowidAlias ?? "<none>") "
                        + "reference=\(refTable.rowidAlias ?? "<none>")")
            }
        }

        // Indexes — compared by NAME across the board: both sides are SQLite
        // replaying the SAME ladder, so even the `sqlite_autoindex_<t>_<n>`
        // numbering must line up (and does; a divergence means the CREATE order
        // drifted from the JS migrations).
        let nativeIndexNames = Set(native.indexes.keys)
        let refIndexNames = Set(reference.indexes.keys)
        report.indexOnlyInNative = nativeIndexNames.subtracting(refIndexNames).sorted()
        report.indexOnlyInReference = refIndexNames.subtracting(nativeIndexNames).sorted()
        for name in nativeIndexNames.intersection(refIndexNames).sorted() {
            let a = native.indexes[name]!
            let b = reference.indexes[name]!
            if a != b {
                report.indexDiffs.append(
                    "\(name): native(table=\(a.table) unique=\(a.unique) cols=\(a.columns)) "
                        + "≠ reference(table=\(b.table) unique=\(b.unique) cols=\(b.columns))")
            }
        }

        // FTS.
        let nativeFTSNames = Set(native.fts.keys)
        let refFTSNames = Set(reference.fts.keys)
        report.ftsOnlyInNative = nativeFTSNames.subtracting(refFTSNames).sorted()
        report.ftsOnlyInReference = refFTSNames.subtracting(nativeFTSNames).sorted()
        for name in nativeFTSNames.intersection(refFTSNames).sorted() {
            let a = native.fts[name]!
            let b = reference.fts[name]!
            if a != b {
                report.ftsDiffs.append(
                    "\(name): native(cols=\(a.columns) tokenize='\(a.tokenize)' content=\(a.content)) "
                        + "≠ reference(cols=\(b.columns) tokenize='\(b.tokenize)' content=\(b.content))")
            }
        }

        // Triggers.
        let nativeTrigNames = Set(native.triggers.keys)
        let refTrigNames = Set(reference.triggers.keys)
        report.triggerOnlyInNative = nativeTrigNames.subtracting(refTrigNames).sorted()
        report.triggerOnlyInReference = refTrigNames.subtracting(nativeTrigNames).sorted()
        for name in nativeTrigNames.intersection(refTrigNames).sorted() {
            let a = native.triggers[name]!
            let b = reference.triggers[name]!
            if a.normalizedSQL != b.normalizedSQL {
                report.triggerDiffs.append(
                    "\(name):\n      native    = \(a.normalizedSQL)\n      reference = \(b.normalizedSQL)")
            }
        }

        return report
    }

    /// A per-column diff for one table, listing exactly which columns differ.
    private static func columnDiffDescription(
        table: String, native: TableModel, reference: TableModel
    ) -> String {
        var lines: [String] = ["\(table):"]
        let nativeByName = Dictionary(uniqueKeysWithValues: native.columns.map { ($0.name, $0) })
        let refByName = Dictionary(uniqueKeysWithValues: reference.columns.map { ($0.name, $0) })
        let allNames = Set(nativeByName.keys).union(refByName.keys).sorted()
        for name in allNames {
            let n = nativeByName[name]
            let r = refByName[name]
            if n == r { continue }
            if let n, let r {
                lines.append("      col '\(name)': native(\(render(n))) ≠ reference(\(render(r)))")
            } else if let n {
                lines.append("      col '\(name)': only in native (\(render(n)))")
            } else if let r {
                lines.append("      col '\(name)': only in reference (\(render(r)))")
            }
        }
        // Also flag a pure ordering difference (same column set, different order).
        if native.columns.map(\.name) != reference.columns.map(\.name),
            Set(native.columns.map(\.name)) == Set(reference.columns.map(\.name))
        {
            lines.append("      [column ORDER differs]")
            lines.append("        native   : \(native.columns.map(\.name).joined(separator: ","))")
            lines.append("        reference: \(reference.columns.map(\.name).joined(separator: ","))")
        }
        return lines.joined(separator: "\n")
    }

    private static func render(_ c: ColumnModel) -> String {
        "type=\(c.type) notnull=\(c.notNull) default=\(c.defaultValue ?? "<none>")"
    }
}

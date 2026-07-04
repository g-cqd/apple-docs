// The apple-docs SCHEMA PARITY gate — the deliverable's proof.
//
// Builds the native ADDB catalog (ADWrite/migrateSchema → `txn.schema()`) and the
// JS-migrated SQLite reference (DocsDatabase → sqlite_master / PRAGMA table_info),
// projects BOTH into the engine-agnostic `CatalogModel`, and asserts they MATCH:
// same tables (each with the same columns: name + type + notnull + default +
// rowid-alias PK), same indexes (incl. the implied unique auto-indexes), same
// triggers, same FTS virtual tables. On any mismatch the test prints a precise
// diff and fails; it passes only on a full logical match.
//
// Strict-typing / representational normalizations relied on (each documented at
// its normalization point and re-stated in the diff report):
//   • ADDB stores a SQLite TEXT/INTEGER/REAL/BLOB affinity as its strict
//     ColumnType — compared as the logical type name (identical token set).
//   • Composite / non-integer PRIMARY KEYs are nil rowid-aliases on BOTH sides
//     (each falls back to a hidden rowid + a `sqlite_autoindex_*` unique index,
//     which the index set compares identically).
//   • The partial predicate on idx_sf_symbols_codepoint and the per-index COLLATE
//     on idx_documents_title_nocase are dropped by ADDB; the indexes still match
//     on name/table/columns/uniqueness (predicate + per-index collation are not
//     part of the logical comparison — noted in the report).
//   • ADDB's `schema_version` migrator-cursor table is excluded (its apple-docs
//     analog, `schema_meta`, exists on both sides).

import ADDBMigrate
import Foundation
import Testing

@testable import ADWrite

@Suite("apple-docs schema parity (native ADDB vs the committed JS SQLite reference)")
struct SchemaParityTests {
    /// The JS-migrated SQLite catalog, captured ONCE from the Bun `bun:sqlite` migrations (see
    /// `captureReferenceFixture`) and frozen here as the parity reference — so the gate runs with no `bun`
    /// or `src/` dependency (the JS is the original reference; it is now committed, per the RFC 0001 §10
    /// reference-flip). Read from the source tree via `#filePath` (like ADEmbedTests' fixtures).
    static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().appendingPathComponent("Fixtures/js-sqlite-catalog.json")

    @Test("native ADDB catalog matches the committed JS SQLite reference")
    func nativeCatalogMatchesReference() throws {
        // ── Native ADDB catalog ──────────────────────────────────────────────
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("addb-parity-native-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let (native, outcome) = try ADDBCatalogExtractor.build(inDirectory: tmpDir.path)
        // The migrator must have driven the cursor to the apple-docs latest version.
        #expect(outcome.finalVersion == AppleDocsSchema.latestVersion)

        // ── Committed JS SQLite reference (no bun) ────────────────────────────
        let reference = try JSONDecoder()
            .decode(
                CatalogModel.self, from: Data(contentsOf: Self.fixtureURL))

        // ── Diff ─────────────────────────────────────────────────────────────
        let report = SchemaDiff.compare(native: native, reference: reference)
        print(report.render())
        #expect(report.isMatch, "schema parity mismatch — see the printed diff above")
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
    /// apple-docs NATIVE columns absent from the JS reference catalog (the v28 search-denorm columns).
    /// Dropped from the native side before the per-table column compare — see the note at the call site.
    static let nativeOnlyColumns: [String: Set<String>] = [
        "documents": ["title_lc", "key_lc", "year_num", "track_lc", "root_display", "root_slug"]
    ]

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
            lines.append("apple-docs SCHEMA PARITY — native ADDB (ADSQLv0) vs JS SQLite reference")
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
                lines.append("Representational normalizations relied on (logical parity, by design):")
                lines.append("  • SQLite affinity ↔ ADDB strict ColumnType (compared by logical type name).")
                lines.append("  • Composite/TEXT PKs → hidden rowid + sqlite_autoindex_* unique index on")
                lines.append("    BOTH engines (rowid-alias PK is nil for both; the autoindex set matches).")
                lines.append("  • PK-implies-NOT-NULL: SQLite reports notnull=0 for a TEXT/composite PK")
                lines.append("    column (it doesn't enforce it); ADDB marks it NOT NULL. The reference")
                lines.append("    is normalized to NOT NULL for non-rowid-alias PK columns to match.")
                lines.append("  • Implied autoindexes compared as a per-table SET of (columns,unique):")
                lines.append("    SQLite vs ADDB can assign the _1/_2 suffix in a different order when a")
                lines.append("    table has both a composite PK and a UNIQUE (framework_synonyms); the")
                lines.append("    unique column-sets are identical, only the numeric label order differs.")
                lines.append("  • idx_sf_symbols_codepoint: partial predicate (WHERE codepoint IS NOT NULL)")
                lines.append("    dropped by ADDB — index matches on name/table/columns/uniqueness.")
                lines.append("  • idx_documents_title_nocase: per-index COLLATE NOCASE dropped by ADDB —")
                lines.append("    index matches on name/table/columns/uniqueness.")
                lines.append("  • CHECK constraints dropped by ADDB; SQLite never surfaces them in")
                lines.append("    table_info, so column parity is unaffected.")
                lines.append("  • ADDB schema_version (migrator cursor) excluded; schema_meta exists on both.")
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
            // apple-docs NATIVE columns with no JS-catalog equivalent (the v28 search-denorm columns on
            // `documents`) are dropped from the native side before the column compare — the JS reference
            // schema stops at v27 and never declares them. This is the documented native-only divergence
            // (mirrors the `schema_version` table exclusion); every other column must still match exactly.
            let nativeCompared = nativeTable.droppingColumns(Self.nativeOnlyColumns[name] ?? [])
            if nativeCompared.columns != refTable.columns {
                report.columnDiffs.append(
                    columnDiffDescription(table: name, native: nativeCompared, reference: refTable))
            }
            if nativeTable.rowidAlias != refTable.rowidAlias {
                report.rowidAliasDiffs.append(
                    "\(name): native=\(nativeTable.rowidAlias ?? "<none>") "
                        + "reference=\(refTable.rowidAlias ?? "<none>")")
            }
        }

        // Indexes. Split EXPLICIT (`CREATE INDEX idx_*`) from IMPLIED
        // (`sqlite_autoindex_*`, synthesized by UNIQUE constraints / composite PKs).
        //   • Explicit indexes are compared by NAME (their names are author-chosen
        //     and identical on both engines).
        //   • Implied autoindexes are compared per-table as a SET of (columns,
        //     unique): SQLite and ADDB can assign the numeric suffix (_1/_2) in a
        //     DIFFERENT ORDER when a table has BOTH a composite PK and a separate
        //     UNIQUE (SQLite ordered the inline-column UNIQUE before the table-level
        //     PK for framework_synonyms; ADDB lists the PK first). The LOGICAL
        //     content — which column sets are unique — is identical; only the _N
        //     label differs. A set comparison captures that faithfully while still
        //     failing on a genuinely missing/extra/altered unique constraint.
        func isImplied(_ name: String) -> Bool { name.hasPrefix("sqlite_autoindex_") }

        let nativeExplicit = native.indexes.filter { !isImplied($0.key) }
        let refExplicit = reference.indexes.filter { !isImplied($0.key) }
        let nativeExplicitNames = Set(nativeExplicit.keys)
        let refExplicitNames = Set(refExplicit.keys)
        report.indexOnlyInNative = nativeExplicitNames.subtracting(refExplicitNames).sorted()
        report.indexOnlyInReference = refExplicitNames.subtracting(nativeExplicitNames).sorted()
        for name in nativeExplicitNames.intersection(refExplicitNames).sorted() {
            let a = nativeExplicit[name]!
            let b = refExplicit[name]!
            if a != b {
                report.indexDiffs.append(
                    "\(name): native(table=\(a.table) unique=\(a.unique) cols=\(a.columns)) "
                        + "≠ reference(table=\(b.table) unique=\(b.unique) cols=\(b.columns))")
            }
        }

        // Implied autoindexes → per-table content sets, "table | col,col | unique".
        func impliedSet(_ indexes: [String: IndexModel]) -> [String: Set<String>] {
            var byTable: [String: Set<String>] = [:]
            for index in indexes.values where isImplied(index.name) {
                let signature = "\(index.columns.joined(separator: ",")) | unique=\(index.unique)"
                byTable[index.table, default: []].insert(signature)
            }
            return byTable
        }
        let nativeImplied = impliedSet(native.indexes)
        let refImplied = impliedSet(reference.indexes)
        let impliedTables = Set(nativeImplied.keys).union(refImplied.keys).sorted()
        for table in impliedTables {
            let a = nativeImplied[table] ?? []
            let b = refImplied[table] ?? []
            if a != b {
                let onlyNative = a.subtracting(b).sorted()
                let onlyRef = b.subtracting(a).sorted()
                var detail = "\(table): implied unique-index sets differ"
                if !onlyNative.isEmpty { detail += "\n        only native   : \(onlyNative)" }
                if !onlyRef.isEmpty { detail += "\n        only reference: \(onlyRef)" }
                report.indexDiffs.append(detail)
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

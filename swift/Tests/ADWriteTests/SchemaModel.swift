// A normalized, engine-agnostic description of a database catalog, used as the
// common comparison shape for the apple-docs SCHEMA PARITY gate. Both sides — the
// native ADDB catalog (via `txn.schema()`) and the JS-migrated SQLite reference
// (via `sqlite_master` / `PRAGMA table_info`) — are projected into this model and
// diffed. Equality of the two `CatalogModel`s is the deliverable's proof.
//
// The model deliberately compares LOGICAL shape, normalizing away differences in
// how each engine REPRESENTS the same SQL (documented at each normalization
// point). The parity test reports any representational normalization it relied on.

import Foundation

/// One column's logical shape: name, type, NOT NULL, and a normalized default.
/// `pk` is intentionally NOT stored here — primary-key parity is compared via
/// ``TableModel/rowidAlias`` (the only PK form ADDB models as a true PK) plus the
/// implied unique-index set, which captures composite / non-integer PKs
/// identically on both engines (see SchemaModel comparison notes).
struct ColumnModel: Equatable, Comparable, Sendable, Codable {
    var name: String
    /// Logical storage class, upper-cased: "INTEGER" | "REAL" | "TEXT" | "BLOB".
    var type: String
    var notNull: Bool
    /// Canonical default rendering, or nil for "no default":
    ///   • text default      → "'value'"   (single-quoted)
    ///   • integer default   → "123"
    ///   • real default      → "1.5"
    ///   • datetime('now')   → "datetime('now')"
    ///   • explicit NULL     → "NULL"
    var defaultValue: String?

    static func < (lhs: ColumnModel, rhs: ColumnModel) -> Bool { lhs.name < rhs.name }
}

/// One table's logical shape.
struct TableModel: Equatable, Sendable, Codable {
    var name: String
    /// Columns in declared order (order matters — both engines preserve it).
    var columns: [ColumnModel]
    /// The single INTEGER-PRIMARY-KEY rowid-alias column, or nil. This is the only
    /// PK form SQLite stores as a rowid alias AND the only one ADDB models as a
    /// `.rowidAlias`; composite / TEXT PKs are nil on BOTH sides (each falls back
    /// to a hidden rowid + an implied unique index, which the index set compares).
    var rowidAlias: String?

    /// A copy with the named columns removed — used to drop apple-docs-native columns (the v28
    /// search-denorm set) from the native side before comparing against the JS reference catalog.
    func droppingColumns(_ names: Set<String>) -> TableModel {
        guard !names.isEmpty else { return self }
        var copy = self
        copy.columns = columns.filter { !names.contains($0.name) }
        return copy
    }
}

/// One secondary / implied index. `unique` covers both explicit `CREATE UNIQUE
/// INDEX` and the `sqlite_autoindex_*` rows that UNIQUE constraints / composite
/// PKs synthesize on both engines.
struct IndexModel: Equatable, Comparable, Sendable, Codable {
    var name: String
    var table: String
    /// Key columns in order.
    var columns: [String]
    var unique: Bool

    static func < (lhs: IndexModel, rhs: IndexModel) -> Bool { lhs.name < rhs.name }
}

/// One FTS5 virtual table's logical config.
struct FTSModel: Equatable, Comparable, Sendable, Codable {
    var name: String
    var columns: [String]
    /// Whitespace-joined tokenizer spec, e.g. "porter unicode61" or
    /// "trigram case_sensitive 0".
    var tokenize: String
    /// "self" | "external:<table>:<rowid>" | "contentless:<0|1>".
    var content: String

    static func < (lhs: FTSModel, rhs: FTSModel) -> Bool { lhs.name < rhs.name }
}

/// One trigger, compared by its normalized body so whitespace / casing noise from
/// either engine's round-trip doesn't cause false diffs.
struct TriggerModel: Equatable, Comparable, Sendable, Codable {
    var name: String
    /// The trigger's defining SQL, normalized: collapsed whitespace, upper-cased
    /// keywords are NOT forced (the parser-agnostic compare lowercases the whole
    /// text and squeezes runs of whitespace — enough to ignore formatting while
    /// still catching a real body difference).
    var normalizedSQL: String

    static func < (lhs: TriggerModel, rhs: TriggerModel) -> Bool { lhs.name < rhs.name }
}

/// The whole catalog, normalized for cross-engine comparison.
struct CatalogModel: Equatable, Sendable, Codable {
    var tables: [String: TableModel]
    var indexes: [String: IndexModel]
    var fts: [String: FTSModel]
    var triggers: [String: TriggerModel]
}

// MARK: - Normalization helpers shared by both extractors

enum SchemaNormalize {
    /// FTS5 shadow tables SQLite materializes per virtual table. They are an
    /// implementation detail of SQLite's FTS (ADDB stores FTS as a single catalog
    /// record, with no shadow tables), so they are excluded from the logical table
    /// set on the SQLite side.
    static let ftsShadowSuffixes = ["_data", "_idx", "_docsize", "_config", "_content"]

    /// Tables that are engine bookkeeping, not part of the apple-docs logical
    /// schema, and therefore excluded from BOTH sides' table sets:
    ///   • `sqlite_sequence`  — SQLite's AUTOINCREMENT high-water store (ADDB keeps
    ///     the same bookkeeping in its catalog under a reserved key, not as a table).
    ///   • `schema_version`   — ADSQLMigrate's integer migration cursor (the
    ///     apple-docs analog is `schema_meta`, which DOES exist on both sides). The
    ///     JS reference has no `schema_version` table.
    static let engineBookkeepingTables: Set<String> = ["sqlite_sequence", "schema_version"]

    /// The FTS virtual-table base names (compared as FTS, never as plain tables).
    /// Derived dynamically by each extractor; this constant documents the expected
    /// final set after the full migration history.
    static let expectedFTSNames: Set<String> = [
        "documents_fts", "documents_trigram", "documents_body_fts", "sf_symbols_fts"
    ]

    /// True when `name` is an FTS shadow table for one of `ftsBases`.
    static func isFTSShadow(_ name: String, ftsBases: Set<String>) -> Bool {
        for base in ftsBases {
            for suffix in ftsShadowSuffixes where name == base + suffix { return true }
        }
        return false
    }

    /// Collapse all runs of whitespace to a single space, trim, and lowercase —
    /// the trigger-body comparison normalizer (ignores formatting, keeps content).
    static func normalizeTriggerSQL(_ sql: String) -> String {
        let lowered = sql.lowercased()
        let collapsed = lowered.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" })
            .joined(separator: " ")
        return collapsed.trimmingCharacters(in: .whitespaces)
    }
}

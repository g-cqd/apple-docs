// Projects the native ADDB catalog (`ADSQLModel.Schema`, read via ADDB's public
// `txn.schema()`) into the engine-agnostic ``CatalogModel`` for the parity gate.
//
// This is the "introspect its catalog via ADDB's schema API" half of the gate:
// open a fresh ADDB database, run `migrateSchema`, then read the committed schema
// and normalize it to the same shape the SQLite reference is projected into.

import ADDB
import ADDBMigrate
import ADSQLModel
import ADWrite
import Foundation

enum ADDBCatalogExtractor {
    /// Opens a fresh ADDB database under `directory`, runs the apple-docs
    /// `migrateSchema`, reads the committed catalog via `txn.schema()`, and projects
    /// it into a normalized ``CatalogModel``. Also returns the migrator outcome so
    /// the test can assert the cursor landed on the expected version.
    static func build(inDirectory directory: String) throws -> (CatalogModel, Migrator.Outcome) {
        let path =
            directory.hasSuffix("/")
            ? directory + "apple-docs-schema.adsql"
            : directory + "/apple-docs-schema.adsql"
        let db = try Database.open(at: path, options: DatabaseOptions())
        defer { db.close() }

        let outcome = try migrateSchema(db)

        // Read the committed schema in a read snapshot. `txn.schema()` is ADDB's
        // public catalog introspection (the engine's analog of sqlite_master).
        let schema: Schema = try db.read { (txn: borrowing ReadTxn) throws(DBError) in
            try txn.schema()
        }

        return (project(schema), outcome)
    }

    /// Project an ADDB `Schema` into the normalized comparison model.
    static func project(_ schema: Schema) -> CatalogModel {
        // FTS base names from the catalog drive shadow-table exclusion (ADDB has no
        // shadow tables, but the constant keeps the two extractors symmetric).
        let ftsNames = Set(schema.ftsTables.keys)

        // Tables: drop engine bookkeeping (schema_version is the migrator cursor).
        var tables: [String: TableModel] = [:]
        for (name, def) in schema.tables {
            if SchemaNormalize.engineBookkeepingTables.contains(name) { continue }
            tables[name] = projectTable(def)
        }

        // Indexes: every IndexDefinition, incl. the implied `sqlite_autoindex_*`
        // that UNIQUE constraints / composite PKs synthesize (ADDB persists those).
        var indexes: [String: IndexModel] = [:]
        for (name, def) in schema.indexes {
            indexes[name] = IndexModel(
                name: name, table: def.table, columns: def.columns, unique: def.unique)
        }

        // FTS virtual tables.
        var fts: [String: FTSModel] = [:]
        for (name, def) in schema.ftsTables {
            fts[name] = FTSModel(
                name: name,
                columns: def.columns,
                tokenize: def.tokenize.joined(separator: " "),
                content: projectContent(def.content))
        }

        // Triggers: the catalog stores raw CREATE TRIGGER text (like sqlite_schema),
        // normalized identically to the SQLite side.
        var triggers: [String: TriggerModel] = [:]
        for (name, sql) in schema.triggerTexts {
            triggers[name] = TriggerModel(
                name: name, normalizedSQL: SchemaNormalize.normalizeTriggerSQL(sql))
        }

        _ = ftsNames  // documented symmetry; ADDB has no shadow tables to exclude.
        return CatalogModel(tables: tables, indexes: indexes, fts: fts, triggers: triggers)
    }

    private static func projectTable(_ def: TableDefinition) -> TableModel {
        var columns: [ColumnModel] = []
        columns.reserveCapacity(def.columns.count)
        for column in def.columns {
            columns.append(
                ColumnModel(
                    name: column.name,
                    type: column.type.name,  // "INTEGER" | "REAL" | "TEXT" | "BLOB"
                    notNull: column.notNull,
                    defaultValue: projectDefault(column.defaultValue)))
        }
        // Only an INTEGER PRIMARY KEY is a rowid alias; composite / TEXT PKs are
        // `.implicitRowid` here (and nil on the SQLite side too).
        let rowidAlias: String?
        if case .rowidAlias(let col, _) = def.primaryKey {
            rowidAlias = col
        } else {
            rowidAlias = nil
        }
        return TableModel(name: def.name, columns: columns, rowidAlias: rowidAlias)
    }

    /// Canonical default rendering, matching the SQLite-side projection exactly.
    private static func projectDefault(_ value: DefaultValue?) -> String? {
        switch value {
            case nil:
                return nil
            case .datetimeNow:
                return "datetime('now')"
            case .value(.null):
                return "NULL"
            case .value(.integer(let v)):
                return String(v)
            case .value(.real(let d)):
                return canonicalReal(d)
            case .value(.text(let s)):
                return "'\(s)'"
            case .value(.blob):
                // No BLOB column defaults exist in the apple-docs schema; render a
                // stable token so a future one would surface as a diff, not a crash.
                return "x''"
        }
    }

    private static func projectContent(_ content: FTSContentMode) -> String {
        switch content {
            case .selfContained:
                return "self"
            case .external(let table, let rowid):
                return "external:\(table):\(rowid)"
            case .contentless(let deleteEnabled):
                return "contentless:\(deleteEnabled ? 1 : 0)"
        }
    }

    /// Render a REAL the same way the SQLite-side parser does, so "0.0" vs "0"
    /// style differences never cause a false diff (no such defaults exist today;
    /// this keeps the rendering defined).
    private static func canonicalReal(_ d: Double) -> String {
        if d == d.rounded() && abs(d) < 1e15 {
            return String(Int64(d)) + ".0"
        }
        return String(d)
    }
}

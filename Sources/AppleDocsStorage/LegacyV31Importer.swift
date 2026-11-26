/// Detects and imports legacy Bun v31 `apple-docs.db` corpora into a clean Swift v1 ``CorpusStore``.
///
/// Opens the legacy database read-only (never mutating it) via SQLite `ATTACH DATABASE` inside a
/// single write transaction so multi-hundred-thousand-row corpora migrate directly inside SQLite
/// while rebuilding FTS5 and trigram indexes cleanly and preserving stable document IDs.
public enum LegacyV31Importer: Sendable {
    /// Inspects an existing SQLite database at `path` and returns its detected ``CorpusSchemaVersion``,
    /// or `nil` if it is neither a Swift v1 nor a legacy Bun v31 corpus.
    public static func detectSchema(at path: String) throws(SQLiteError) -> CorpusSchemaVersion? {
        let conn = try SQLiteConnection(path: path, options: .readOnly)
        defer { conn.close() }
        return try detectSchema(on: conn)
    }

    /// Inspects an open read-only ``SQLiteConnection`` and returns its detected ``CorpusSchemaVersion``.
    public static func detectSchema(on connection: SQLiteConnection) throws(SQLiteError) -> CorpusSchemaVersion? {
        let userVersion = try connection.userVersion()
        if userVersion == CorpusSchemaVersion.swiftV1.rawValue {
            return .swiftV1
        }
        guard try tableExists(on: connection, name: "schema_meta") else {
            return nil
        }
        guard
            let row = try connection.queryOne("SELECT value FROM schema_meta WHERE key = 'schema_version'"),
            let versionString = try row.optionalText(at: 0),
            let version = Int(versionString),
            version >= CorpusSchemaVersion.legacyBunV31.rawValue
        else {
            return nil
        }
        return .legacyBunV31
    }

    /// Imports a read-only Bun v31 corpus at `legacyPath` into `destination` (Swift v1 ``CorpusStore``).
    public static func importDatabase(
        from legacyPath: String,
        into destination: CorpusStore,
        includeRawPayloads: Bool = true,
        rebuildFTS: Bool = true
    ) throws -> LegacyImportReport {
        let probe = try SQLiteConnection(path: legacyPath, options: .readOnly)
        let detected: CorpusSchemaVersion?
        let rawVersion: Int
        let availableTables: Set<String>
        do {
            detected = try detectSchema(on: probe)
            rawVersion = try readLegacyVersion(on: probe)
            availableTables = try listTables(on: probe)
        } catch {
            probe.close()
            throw error
        }
        probe.close()

        guard detected == .legacyBunV31 else {
            throw SQLiteError.unsupportedSchema(found: rawVersion)
        }

        let db = destination.connection
        try db.execute("ATTACH DATABASE ? AS legacy", bindings: [.text("file:\(legacyPath)?mode=ro")])
        defer { try? db.execute("DETACH DATABASE legacy") }

        try db.transaction {
            try copyCoreTables(on: db, available: availableTables)
            try copyOptionalTables(on: db, available: availableTables, includeRawPayloads: includeRawPayloads)
            if rebuildFTS {
                try rebuildSearchIndexes(on: db, available: availableTables)
            }
            try db.execute(
                "INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES ('imported_from_schema', ?)",
                bindings: [.text(String(rawVersion))]
            )
        }

        return try buildReport(on: db, sourceVersion: rawVersion)
    }

    static func readLegacyVersion(on db: SQLiteConnection) throws(SQLiteError) -> Int {
        guard try tableExists(on: db, name: "schema_meta") else {
            return try db.userVersion()
        }
        guard
            let row = try db.queryOne("SELECT value FROM schema_meta WHERE key = 'schema_version'"),
            let text = try row.optionalText(at: 0),
            let value = Int(text)
        else {
            return try db.userVersion()
        }
        return value
    }

    static func listTables(on db: SQLiteConnection) throws(SQLiteError) -> Set<String> {
        let rows = try db.query("SELECT name FROM sqlite_master WHERE type = 'table'")
        return Set(try rows.map { row throws(SQLiteError) in try row.text(at: 0) })
    }

    static func tableExists(on db: SQLiteConnection, name: String) throws(SQLiteError) -> Bool {
        let row = try db.queryOne(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            bindings: [.text(name)]
        )
        return row != nil
    }

    static func buildReport(on db: SQLiteConnection, sourceVersion: Int) throws(SQLiteError) -> LegacyImportReport {
        var counts: [LegacyImportReport.Table: Int] = [:]
        counts.reserveCapacity(LegacyImportReport.Table.allCases.count)
        for table in LegacyImportReport.Table.allCases {
            if let row = try db.queryOne("SELECT COUNT(*) FROM \(table.rawValue)") {
                counts[table] = Int(try row.integer(at: 0))
            }
        }
        return LegacyImportReport(sourceSchemaVersion: sourceVersion, tableCounts: counts)
    }
}

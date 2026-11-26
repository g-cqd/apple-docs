import AppleDocsStorage

/// Bun's search repository queries (`storage/repos/search.js`, `roots.js`, `documents.js`) over the Swift corpus.
public enum SearchRepository {
    private static func from(_ table: String) -> String {
        "JOIN documents d ON \(table).rowid = d.id LEFT JOIN roots r ON r.slug = d.framework"
    }

    /// `searchPages`: lexical FTS5 with Bun's title tier (`0` exact, `1` prefix, `2` contains, `3` match).
    static func searchPages(
        _ ftsQuery: String,
        raw: String,
        filter: SearchSQLFilter,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [SearchRecord] {
        let sql = """
            SELECT \(SearchRecord.columns),
                   CASE
                     WHEN LOWER(d.title) = LOWER($raw) THEN 0
                     WHEN LOWER(d.key) = LOWER($raw) THEN 0
                     WHEN LOWER(d.title) LIKE LOWER($raw) || '%' THEN 1
                     WHEN INSTR(LOWER(d.title), LOWER($raw)) > 0 THEN 2
                     ELSE 3
                   END AS tier,
                   bm25(documents_fts, 10.0, 5.0, 3.0, 2.0, 1.0) AS rank
            FROM documents_fts \(from("documents_fts"))
            WHERE documents_fts MATCH $query
              \(SearchSQLFilter.predicates)
            ORDER BY tier, rank
            LIMIT $limit
            """
        var bindings = filter.bindings
        bindings["$query"] = .text(ftsQuery)
        bindings["$raw"] = .text(raw)
        return try connection.query(sql, named: bindings)
            .map { row throws(SQLiteError) in
                try SearchRecord(row: row, tier: Int(try row.integer(at: SearchRecord.columnCount)))
            }
    }

    /// `searchTitleExact`: case-insensitive title equality, symbols first, then shortest keys.
    static func searchTitleExact(
        _ raw: String,
        filter: SearchSQLFilter,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [SearchRecord] {
        let sql = """
            SELECT \(SearchRecord.columns)
            FROM documents d LEFT JOIN roots r ON r.slug = d.framework
            WHERE d.title = $raw COLLATE NOCASE
              \(SearchSQLFilter.predicates)
            ORDER BY CASE WHEN d.role = 'symbol' OR d.kind = 'symbol' THEN 0 ELSE 1 END, length(d.key)
            LIMIT $limit
            """
        var bindings = filter.bindings
        bindings["$raw"] = .text(raw)
        return try connection.query(sql, named: bindings)
            .map { row throws(SQLiteError) in
                try SearchRecord(row: row, tier: 0)
            }
    }

    /// `searchTrigram` (errors yield no rows, like Bun's `safeCall`).
    static func searchTrigram(_ query: String, filter: SearchSQLFilter, on connection: SQLiteConnection)
        -> [SearchRecord]
    {
        virtualTable(
            "documents_trigram",
            order: "bm25(documents_trigram)",
            query: query,
            filter: filter,
            on: connection
        )
    }

    /// `searchBody` (errors yield no rows).
    static func searchBody(_ ftsQuery: String, filter: SearchSQLFilter, on connection: SQLiteConnection)
        -> [SearchRecord]
    {
        virtualTable(
            "documents_body_fts",
            order: "bm25(documents_body_fts, 1.0)",
            query: ftsQuery,
            filter: filter,
            on: connection
        )
    }

    private static func virtualTable(
        _ table: String,
        order: String,
        query: String,
        filter: SearchSQLFilter,
        on connection: SQLiteConnection
    ) -> [SearchRecord] {
        let sql = """
            SELECT \(SearchRecord.columns)
            FROM \(table) \(from(table))
            WHERE \(table) MATCH $query
              \(SearchSQLFilter.predicates)
            ORDER BY \(order)
            LIMIT $limit
            """
        var bindings = filter.bindings
        bindings["$query"] = .text(query)
        let rows = (try? connection.query(sql, named: bindings)) ?? []
        return rows.compactMap { try? SearchRecord(row: $0) }
    }

    /// `hasBodyIndex`.
    static func hasBodyIndex(on connection: SQLiteConnection) -> Bool {
        ((try? connection.queryOne("SELECT 1 FROM documents_body_fts LIMIT 1")) ?? nil) != nil
    }

    /// `getSearchRecordsByIds` (any order).
    static func records(ids: [Int64], on connection: SQLiteConnection) throws(SQLiteError) -> [SearchRecord] {
        var out: [SearchRecord] = []
        for start in stride(from: 0, to: ids.count, by: 500) {
            let batch = ids[start ..< min(start + 500, ids.count)]
            let sql = """
                SELECT d.id, \(SearchRecord.columns)
                FROM documents d LEFT JOIN roots r ON r.slug = d.framework
                WHERE d.id IN (\(SQLiteConnection.placeholders(batch.count)))
                """
            for row in try connection.query(sql, bindings: batch.map(SQLiteValue.integer)) {
                out.append(try SearchRecord(row: row, offset: 1, id: try row.integer(at: 0)))
            }
        }
        return out
    }

    /// `getFrameworkSynonyms`: aliases of a canonical slug and canonicals of an alias.
    static func frameworkSynonyms(_ slug: String, on connection: SQLiteConnection) -> [String] {
        let normalized = slug.lowercased()
        let rows =
            (try? connection.query(
                """
                SELECT alias FROM framework_synonyms WHERE canonical = ?
                UNION
                SELECT canonical FROM framework_synonyms WHERE alias = ?
                """,
                bindings: [.text(normalized), .text(normalized)]
            )) ?? []
        return rows.compactMap { try? $0.text(at: 0) }
    }
}

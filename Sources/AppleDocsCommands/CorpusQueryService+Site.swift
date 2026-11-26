public import AppleDocsCore
public import AppleDocsOutput
public import AppleDocsStorage

/// Website/static-site queries: linked related documents and per-framework key listings for sitemaps.
extension CorpusQueryService {
    /// Outgoing relationships of `key` (topics `child`, `see_also`, conformances…) in source order, each flagged
    /// with whether its target exists in the corpus; missing targets fall back to their last path segment.
    public static func relatedDocuments(
        forKey key: DocumentKey,
        limit: Int = 1_000,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [PublicRelatedDocument] {
        let rows = try connection.query(
            """
            SELECT r.to_key, d.title, r.relation_type, r.section
            FROM document_relationships r
            LEFT JOIN documents d ON d.key = r.to_key
            WHERE r.from_key = ?
            ORDER BY r.relation_type ASC, r.sort_order ASC, r.to_key ASC
            LIMIT ?
            """,
            bindings: [.text(key.rawValue), .integer(Int64(max(1, min(limit, 2_000))))]
        )
        var items: [PublicRelatedDocument] = []
        items.reserveCapacity(rows.count)
        for row in rows {
            let path = try row.text(at: 0)
            let title = try row.optionalText(at: 1)
            items.append(
                PublicRelatedDocument(
                    path: path,
                    title: title ?? path.split(separator: "/").last.map(String.init) ?? path,
                    relationType: try row.text(at: 2),
                    section: try row.optionalText(at: 3),
                    isAvailable: title != nil
                )
            )
        }
        return items
    }

    /// Document keys of one framework, shortest paths first, capped at `limit` (sitemap protocol: 50,000).
    public static func documentKeys(
        framework: String,
        limit: Int = 50_000,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [String] {
        let rows = try connection.query(
            "SELECT key FROM documents WHERE framework = ? ORDER BY url_depth ASC, key ASC LIMIT ?",
            bindings: [.text(framework.lowercased()), .integer(Int64(max(1, min(limit, 50_000))))]
        )
        return try rows.map { row throws(SQLiteError) in try row.text(at: 0) }
    }

    /// Direct children of `key` (one more path segment), by title. A range scan on the unique `key` index,
    /// so the cost is bounded by the subtree size instead of the framework size.
    public static func childDocuments(
        of key: DocumentKey,
        limit: Int = 500,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [PublicDocumentSummary] {
        let prefix = key.rawValue
        let rows = try connection.query(
            """
            SELECT key, title, source_type, is_deprecated, is_beta
            FROM documents
            WHERE key > ? AND key < ? AND instr(substr(key, ?), '/') = 0
            ORDER BY title COLLATE NOCASE ASC, key ASC
            LIMIT ?
            """,
            bindings: [
                .text(prefix + "/"),
                .text(prefix + "0"),  // "0" sorts right after "/": the upper bound of the subtree
                .integer(Int64(prefix.utf8.count + 2)),
                .integer(Int64(max(1, min(limit, 2_000))))
            ]
        )
        return try documentSummaries(from: rows)
    }

    /// Maps `key, title, source_type, is_deprecated, is_beta` rows to summaries, skipping invalid keys.
    static func documentSummaries(from rows: [SQLiteRow]) throws(SQLiteError) -> [PublicDocumentSummary] {
        var items: [PublicDocumentSummary] = []
        items.reserveCapacity(rows.count)
        for row in rows {
            guard let key = try? DocumentKey(try row.text(at: 0)) else { continue }
            items.append(
                PublicDocumentSummary(
                    key: key,
                    title: try row.text(at: 1),
                    sourceType: SourceKind(rawValue: try row.text(at: 2)) ?? .appleDocC,
                    isDeprecated: try row.bool(at: 3),
                    isBeta: try row.bool(at: 4)
                )
            )
        }
        return items
    }
}

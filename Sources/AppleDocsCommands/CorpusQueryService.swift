public import AppleDocsCore
public import AppleDocsOutput
public import AppleDocsSearch
public import AppleDocsStorage
import Foundation

/// Cross-platform read/query/browse/taxonomy command service shared by CLI, MCP, and Web.
///
/// Every public return value passes through `AppleDocsOutput` DTOs so internal row IDs, raw SQLite
/// diagnostics, and filesystem paths never leak across any surface.
public enum CorpusQueryService: Sendable {
    /// Allowed taxonomy dimensions exposed by `list_taxonomy`.
    public enum TaxonomyField: String, Hashable, Sendable, CaseIterable {
        case kind
        case role
        case roleHeading = "role_heading"
        case sourceType = "source_type"
        case framework
    }

    /// Runs a filtered corpus search (using hybrid semantic fusion when `semantic` is provided)
    /// and projects hits through ``PublicSearchResult``.
    public static func search(
        _ request: CorpusSearchRequest,
        semantic: (embedder: Model2VecEmbedder, index: SemanticCorpusIndex)? = nil,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [PublicSearchResult] {
        let hits: [CorpusSearchHit] =
            if let semantic {
                try semantic.index.hybridSearch(request, embedder: semantic.embedder, on: connection)
            } else {
                try CorpusSearchEngine.search(request, on: connection)
            }
        return hits.map { hit in
            PublicSearchResult(document: hit.document, confidence: hit.confidence.rawValue)
        }
    }

    /// Parses a comma-separated source slug string (e.g. `"apple-docc,hig,wwdc"`) into typed ``SourceKind`` values.
    public static func parseSourceKinds(_ csv: String?) -> [SourceKind] {
        guard let csv, !csv.isEmpty else { return [] }
        return
            csv
            .split(separator: ",")
            .compactMap { SourceKind(rawValue: $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) }
    }

    /// Reads a single document and its ordered sections by validated ``DocumentKey``.
    public static func readDocument(
        key: DocumentKey,
        on store: CorpusStore
    ) throws(SQLiteError) -> PublicDocumentDetail? {
        guard let document = try store.document(forKey: key) else { return nil }
        let sections = try store.sections(forKey: key)
        return PublicDocumentDetail(document: document, sections: sections)
    }

    /// Resolves a symbol title (case-insensitive) optionally scoped to `framework` and returns its detail.
    public static func readSymbol(
        named symbol: String,
        framework: String? = nil,
        on store: CorpusStore
    ) throws(SQLiteError) -> PublicDocumentDetail? {
        let sql: String
        let bindings: [SQLiteValue]
        if let framework {
            sql = """
                SELECT key FROM documents
                WHERE title = ? COLLATE NOCASE AND framework = ?
                ORDER BY url_depth ASC LIMIT 1
                """
            bindings = [.text(symbol), .text(framework.lowercased())]
        } else {
            sql = """
                SELECT key FROM documents
                WHERE title = ? COLLATE NOCASE
                ORDER BY url_depth ASC LIMIT 1
                """
            bindings = [.text(symbol)]
        }
        guard let row = try store.connection.queryOne(sql, bindings: bindings) else { return nil }
        let rawKey = try row.text(at: 0)
        guard let key = try? DocumentKey(rawKey) else { return nil }
        return try readDocument(key: key, on: store)
    }

    /// Lists indexed frameworks/collections projected through ``PublicFrameworkSummary``.
    public static func listFrameworks(
        kind: String? = nil,
        on store: CorpusStore
    ) throws(SQLiteError) -> [PublicFrameworkSummary] {
        try store.listRoots(kind: kind).map(PublicFrameworkSummary.init)
    }

    /// Browses direct children under a framework root or parent path prefix.
    public static func browse(
        framework: String,
        pathPrefix: String? = nil,
        limit: Int = 100,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [PublicDocumentSummary] {
        let clampedLimit = max(1, min(limit, 200))
        let prefix = (pathPrefix ?? framework).lowercased()
        let rows = try connection.query(
            """
            SELECT key, title, source_type, is_deprecated, is_beta
            FROM documents
            WHERE framework = ? AND key LIKE ? ESCAPE '\\'
            ORDER BY url_depth ASC, title ASC
            LIMIT ?
            """,
            bindings: [
                .text(framework.lowercased()),
                .text("\(escapeLike(prefix))/%"),
                .integer(Int64(clampedLimit))
            ]
        )
        var items: [PublicDocumentSummary] = []
        items.reserveCapacity(rows.count)
        for row in rows {
            let rawKey = try row.text(at: 0)
            guard let key = try? DocumentKey(rawKey) else { continue }
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

    /// Direction filter for relationship queries.
    public enum LinkDirection: String, Hashable, Sendable, CaseIterable {
        case outgoing
        case incoming
        case both
    }

    /// Queries incoming and/or outgoing relationships for `key` projected through ``PublicDocumentLink``.
    public static func links(
        forKey key: DocumentKey,
        direction: LinkDirection = .both,
        limit: Int = 100,
        on store: CorpusStore
    ) throws(SQLiteError) -> [PublicDocumentLink] {
        let clampedLimit = max(1, min(limit, 500))
        var records: [DocumentRelationshipRecord] = []
        if direction == .outgoing || direction == .both {
            records.append(contentsOf: try store.outgoingRelationships(from: key))
        }
        if direction == .incoming || direction == .both {
            records.append(contentsOf: try store.incomingRelationships(to: key))
        }
        return records.prefix(clampedLimit).map(PublicDocumentLink.init)
    }

    /// Aggregates distinct values and document counts for one taxonomy `field`.
    public static func listTaxonomy(
        field: TaxonomyField,
        limit: Int = 20,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [PublicTaxonomyBucket] {
        let column = field.rawValue
        let clampedLimit = max(1, min(limit, 500))
        let rows = try connection.query(
            """
            SELECT \(column), COUNT(*) AS cnt
            FROM documents
            WHERE \(column) IS NOT NULL AND \(column) != ''
            GROUP BY \(column)
            ORDER BY cnt DESC, \(column) ASC
            LIMIT ?
            """,
            bindings: [.integer(Int64(clampedLimit))]
        )
        return try rows.map { row throws(SQLiteError) in
            PublicTaxonomyBucket(value: try row.text(at: 0), count: Int(try row.integer(at: 1)))
        }
    }

    static func escapeLike(_ value: String) -> String {
        value
            .replacing("\\", with: "\\\\")
            .replacing("%", with: "\\%")
            .replacing("_", with: "\\_")
    }
}

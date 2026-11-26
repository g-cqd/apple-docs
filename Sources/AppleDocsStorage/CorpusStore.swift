public import AppleDocsCore

/// Repository layer over a Swift v1 ``SQLiteConnection`` providing transactional upserts,
/// reads, section management, relationship queries, and root listings.
public final class CorpusStore {
    public let connection: SQLiteConnection
    private let ownsConnection: Bool

    /// Opens (or initializes) a Swift v1 corpus database at `path`.
    public init(path: String, options: SQLiteOpenOptions = .readWrite) throws(SQLiteError) {
        let conn = try SQLiteConnection(path: path, options: options)
        if options.mode == .readWriteCreate {
            let version = try conn.userVersion()
            if version == 0 {
                try CorpusSchemaV1.apply(to: conn)
            } else if version != CorpusSchemaV1.userVersion {
                conn.close()
                throw .unsupportedSchema(found: version)
            } else {
                try CorpusSchemaV1.addMissingColumns(on: conn)
            }
        }
        self.connection = conn
        self.ownsConnection = true
    }

    /// A store over a connection someone else owns (a reader pool's): ``close()`` leaves it open.
    public init(borrowing connection: SQLiteConnection) {
        self.connection = connection
        self.ownsConnection = false
    }

    /// Closes the underlying connection (when this store opened it).
    public func close() {
        if ownsConnection { connection.close() }
    }

    /// Upserts a documentation root entry.
    public func upsertRoot(_ root: CorpusRootRecord) throws(SQLiteError) {
        try connection.execute(
            """
            INSERT INTO roots (
                slug, display_name, kind, source_type, seed_path, page_count, status, index_etag, last_seen
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT(slug) DO UPDATE SET
                display_name = excluded.display_name,
                kind = excluded.kind,
                source_type = excluded.source_type,
                seed_path = excluded.seed_path,
                page_count = excluded.page_count,
                status = excluded.status,
                index_etag = COALESCE(excluded.index_etag, roots.index_etag),
                last_seen = excluded.last_seen,
                updated_at = datetime('now')
            """,
            bindings: [
                .text(root.slug),
                .text(root.displayName),
                .text(root.kind),
                .text(root.sourceType.rawValue),
                .optionalText(root.seedPath),
                .integer(Int64(root.pageCount)),
                .text(root.status),
                .optionalText(root.indexETag)
            ]
        )
    }

    /// Lists all roots ordered by slug, optionally filtered by `kind`.
    public func listRoots(kind: String? = nil) throws(SQLiteError) -> [CorpusRootRecord] {
        let baseSQL = """
            SELECT slug, display_name, kind, source_type, seed_path, page_count, status, index_etag
            FROM roots
            """
        let rows: [SQLiteRow] =
            if let kind {
                try connection.query("\(baseSQL) WHERE kind = ? ORDER BY slug", bindings: [.text(kind)])
            } else {
                try connection.query("\(baseSQL) ORDER BY slug")
            }
        return try rows.map(Self.decodeRoot)
    }

    /// Inserts or updates a directed relationship edge between two document keys.
    public func upsertRelationship(_ relationship: DocumentRelationshipRecord) throws(SQLiteError) {
        try connection.execute(
            """
            INSERT INTO document_relationships (from_key, to_key, relation_type, section, sort_order)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(from_key, to_key, relation_type) DO UPDATE SET
                section = excluded.section,
                sort_order = excluded.sort_order
            """,
            bindings: [
                .text(relationship.fromKey.rawValue),
                .text(relationship.toKey.rawValue),
                .text(relationship.relationType),
                .optionalText(relationship.section),
                .integer(Int64(relationship.sortOrder))
            ]
        )
    }

    /// Returns outgoing relationships from `key`, ordered by `sort_order`.
    public func outgoingRelationships(from key: DocumentKey) throws(SQLiteError) -> [DocumentRelationshipRecord] {
        let rows = try connection.query(
            """
            SELECT from_key, to_key, relation_type, section, sort_order
            FROM document_relationships
            WHERE from_key = ?
            ORDER BY sort_order, to_key
            """,
            bindings: [.text(key.rawValue)]
        )
        return try rows.map(Self.decodeRelationship)
    }

    /// Returns incoming relationships targeting `key`, ordered by `from_key`.
    public func incomingRelationships(to key: DocumentKey) throws(SQLiteError) -> [DocumentRelationshipRecord] {
        let rows = try connection.query(
            """
            SELECT from_key, to_key, relation_type, section, sort_order
            FROM document_relationships
            WHERE to_key = ?
            ORDER BY sort_order, from_key
            """,
            bindings: [.text(key.rawValue)]
        )
        return try rows.map(Self.decodeRelationship)
    }

    /// Deletes a document by key (cascading sections, raw payloads, chunks, vectors, and FTS triggers).
    public func deleteDocument(forKey key: DocumentKey) throws(SQLiteError) {
        try connection.execute("DELETE FROM documents WHERE key = ?", bindings: [.text(key.rawValue)])
    }

    /// Total number of documents stored in the corpus.
    public func documentCount() throws(SQLiteError) -> Int {
        guard let row = try connection.queryOne("SELECT COUNT(*) FROM documents") else { return 0 }
        return Int(try row.integer(at: 0))
    }

    private static func decodeRoot(_ row: SQLiteRow) throws(SQLiteError) -> CorpusRootRecord {
        CorpusRootRecord(
            slug: try row.text(at: 0),
            displayName: try row.text(at: 1),
            kind: try row.text(at: 2),
            sourceType: SourceKind(rawValue: try row.text(at: 3)) ?? .appleDocC,
            seedPath: try row.optionalText(at: 4),
            pageCount: Int(try row.integer(at: 5)),
            status: try row.text(at: 6),
            indexETag: try row.optionalText(at: 7)
        )
    }

    static func decodeDocumentKey(_ row: SQLiteRow, column: Int) throws(SQLiteError) -> DocumentKey {
        let raw = try row.text(at: column)
        do {
            return try DocumentKey(raw)
        } catch {
            throw .typeMismatch(column: column, expected: "DocumentKey (\(error))")
        }
    }

    private static func decodeRelationship(_ row: SQLiteRow) throws(SQLiteError) -> DocumentRelationshipRecord {
        DocumentRelationshipRecord(
            fromKey: try decodeDocumentKey(row, column: 0),
            toKey: try decodeDocumentKey(row, column: 1),
            relationType: try row.text(at: 2),
            section: try row.optionalText(at: 3),
            sortOrder: Int(try row.integer(at: 4))
        )
    }
}

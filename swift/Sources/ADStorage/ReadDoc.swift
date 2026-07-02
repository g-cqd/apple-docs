// Queries for the MCP read_doc tool: readDocument (the documents row joined to
// its root, mirroring database.getPage on a normalized document), the per-type
// relationship counts (getRelationshipCountsByType), the rendered document
// sections (getDocumentSections), and the snapshot tier (getTier). The browse
// query already covers the lighter key+title shape; read_doc needs the full
// metadata row plus the section bodies that feed the markdown renderer.

import ADArchive

/// A normalized documents row as read_doc consumes it. Mirrors the fields
/// `database.getPage` surfaces (key→path, framework_display→framework,
/// abstract_text→abstract, declaration_text→declaration, platforms_json→
/// platforms) plus the columns the markdown renderer needs (role, framework).
public struct DocumentRecord: Sendable {
    public let path: String
    public let title: String?
    /// COALESCE(roots.display_name, documents.framework) — the display name.
    public let frameworkDisplay: String?
    /// The raw `documents.framework` slug column.
    public let framework: String?
    public let rootSlug: String?
    public let role: String?
    public let roleHeading: String?
    public let kind: String?
    public let abstract: String?
    /// Raw `platforms_json` TEXT (JSON.parse'd by the caller; null → []).
    public let platformsJSON: String?
    /// Raw `declaration_text` TEXT (kept verbatim; null → null).
    public let declaration: String?
    /// true only when the INTEGER column holds a non-zero value.
    public let isDeprecated: Bool
    public let isBeta: Bool
}

/// One per-type relationship count, in GROUP BY row order. `name` is the
/// camelCase relation name (children / inheritsFrom / ...); rows whose
/// relation_type has no camelCase mapping are dropped by the caller.
public struct RelationshipCount: Sendable {
    public let relationType: String
    public let count: Int
}

/// A rendered document section as the markdown renderer consumes it. Mirrors
/// the `documents.getSections` row shape (section_kind / heading / content_text
/// / content_json / sort_order), with the type-directed content codec applied.
public struct DocumentSectionRow: Sendable {
    public let sectionKind: String?
    public let heading: String?
    public let contentText: String?
    public let contentJSON: String?
    public let sortOrder: Double
}

extension StorageConnection {
    /// getPage on a normalized document: the documents row joined to its root
    /// (COALESCE slug/display_name onto the framework column), keyed by `key`.
    /// nil when no document row exists (read_doc then retries / gives up).
    public func readDocument(_ key: String) -> DocumentRecord? {
        let sql = """
            SELECT d.key, d.title, COALESCE(r.display_name, d.framework) AS framework_display,
                   d.framework, COALESCE(r.slug, d.framework) AS root_slug, d.role, d.role_heading,
                   d.kind, d.abstract_text, d.platforms_json, d.declaration_text,
                   d.is_deprecated, d.is_beta
            FROM documents d LEFT JOIN roots r ON r.slug = d.framework
            WHERE d.key = ?
            """
        guard let stmt = conn.prepareUncached(sql) else { return nil }
        stmt.bindText(1, key)
        guard stmt.step() == SQLite.row else { return nil }
        return DocumentRecord(
            path: stmt.text(0) ?? key, title: stmt.text(1), frameworkDisplay: stmt.text(2),
            framework: stmt.text(3), rootSlug: stmt.text(4), role: stmt.text(5), roleHeading: stmt.text(6),
            kind: stmt.text(7), abstract: stmt.text(8), platformsJSON: stmt.text(9),
            declaration: stmt.text(10), isDeprecated: (stmt.int(11) ?? 0) != 0,
            isBeta: (stmt.int(12) ?? 0) != 0)
    }

    /// searchByTitle: the best document whose title matches (NOCASE), optionally
    /// constrained to a framework slug, preferring symbols then the shortest key.
    /// Mirrors database.searchByTitle, surfacing the same normalized record shape
    /// as readDocument (so read_doc's symbol path and path path are uniform).
    public func searchByTitle(_ title: String, framework: String?) -> DocumentRecord? {
        let sql = """
            SELECT d.key, d.title, COALESCE(r.display_name, d.framework) AS framework_display,
                   d.framework, COALESCE(r.slug, d.framework) AS root_slug, d.role, d.role_heading,
                   d.kind, d.abstract_text, d.platforms_json, d.declaration_text,
                   d.is_deprecated, d.is_beta
            FROM documents d LEFT JOIN roots r ON r.slug = d.framework
            WHERE d.title = $title COLLATE NOCASE AND ($framework IS NULL OR d.framework = $framework)
            ORDER BY CASE WHEN d.role = 'symbol' OR d.kind = 'symbol' THEN 0 ELSE 1 END, length(d.key)
            LIMIT 1
            """
        guard let stmt = conn.prepareUncached(sql) else { return nil }
        stmt.bind("$title", .text(title))
        stmt.bind("$framework", framework.map(BindValue.text) ?? .null)
        guard stmt.step() == SQLite.row else { return nil }
        return DocumentRecord(
            path: stmt.text(0) ?? "", title: stmt.text(1), frameworkDisplay: stmt.text(2),
            framework: stmt.text(3), rootSlug: stmt.text(4), role: stmt.text(5), roleHeading: stmt.text(6),
            kind: stmt.text(7), abstract: stmt.text(8), platformsJSON: stmt.text(9),
            declaration: stmt.text(10), isDeprecated: (stmt.int(11) ?? 0) != 0,
            isBeta: (stmt.int(12) ?? 0) != 0)
    }

    /// getRelationshipCountsByType: COUNT(*) grouped by relation_type for one
    /// source key, in row order. Empty when the relationships table is absent
    /// (the JS query would throw; read_doc emits no relationships then) or no
    /// rows match. The caller maps relation_type → camelCase and drops the rest.
    public func relationshipCountsByType(_ key: String) -> [RelationshipCount] {
        guard conn.hasRelationships else { return [] }
        let sql = """
            SELECT relation_type, COUNT(*) FROM document_relationships WHERE from_key = ?
            GROUP BY relation_type
            """
        guard let stmt = conn.prepareUncached(sql) else { return [] }
        stmt.bindText(1, key)
        var out: [RelationshipCount] = []
        while stmt.step() == SQLite.row {
            let count = Int(stmt.int(1) ?? 0)
            if let type = stmt.text(0), count > 0 {
                out.append(RelationshipCount(relationType: type, count: count))
            }
        }
        return out
    }

    /// getDocumentSections: the document's sections ordered by (sort_order, id),
    /// with content_text / content_json run through the type-directed codec
    /// (TEXT pass-through, zstd-BLOB inflate). Empty when sections are absent or
    /// the key has no document row.
    public func documentSections(_ key: String) -> [DocumentSectionRow] {
        guard conn.hasSections else { return [] }
        guard let idStmt = conn.prepareUncached("SELECT id FROM documents WHERE key = ?") else { return [] }
        idStmt.bindText(1, key)
        guard idStmt.step() == SQLite.row, let documentId = idStmt.int(0) else { return [] }

        let sql = """
            SELECT section_kind, heading, content_text, content_json, sort_order
            FROM document_sections WHERE document_id = ? ORDER BY sort_order, id
            """
        guard let stmt = conn.prepareUncached(sql) else { return [] }
        stmt.bindInt64(1, documentId)
        var out: [DocumentSectionRow] = []
        while stmt.step() == SQLite.row {
            out.append(
                DocumentSectionRow(
                    sectionKind: stmt.text(0), heading: stmt.text(1),
                    contentText: decodeSectionColumn(stmt, 2), contentJSON: decodeSectionColumn(stmt, 3),
                    sortOrder: stmt.double(4) ?? 0))
        }
        return out
    }

    /// getTier: the snapshot_meta `snapshot_tier` value, else 'full' when a
    /// documents table exists, else nil. read_doc's no-content note text branches
    /// on `'lite'` vs everything else.
    public func snapshotTier() -> String? {
        if let stmt = conn.prepareUncached("SELECT value FROM snapshot_meta WHERE key = 'snapshot_tier'"),
            stmt.step() == SQLite.row, let value = stmt.text(0)
        {
            return value
        }
        return conn.tableExists("documents") ? "full" : nil
    }
}

/// normalizeIdentifier (apple/normalizer.js): canonicalize a pasted identifier
/// — strip doc:// URIs, /documentation/ and documentation/ prefixes (keeping
/// design/ and app-store-review/ namespaces), lowercase, trim trailing slashes
/// and any #fragment — returning nil for non-page identifiers (full URLs, Swift
/// operator segments, empty segments). read_doc retries getPage with this form
/// when the raw path misses.
public func normalizeIdentifier(_ raw: String?) -> String? {
    guard var id = raw, !id.isEmpty else { return nil }

    if id.hasPrefix("http://") || id.hasPrefix("https://") { return nil }

    if let rest = matchDocUri(id, segmentPrefix: "documentation/") {
        id = rest
    } else if let rest = matchDocUri(id, segmentPrefix: "design/") {
        id = "design/" + rest
    }

    if id.hasPrefix("/design/") || id.hasPrefix("/app-store-review/") {
        id = String(id.dropFirst())
    } else if id.hasPrefix("/documentation/") {
        id = String(id.dropFirst("/documentation/".count))
    }
    if id.hasPrefix("documentation/") {
        id = String(id.dropFirst("documentation/".count))
    }

    id = id.lowercased()

    while id.hasSuffix("/") { id = String(id.dropLast()) }

    if let hash = id.firstIndex(of: "#") { id = String(id[..<hash]) }

    if id.isEmpty { return nil }

    let operatorChars: Set<Character> = [".", "-", "+", "*", "/", "<", ">", "=", "!", "&", "|", "^", "~", "%", "_"]
    for segment in id.split(separator: "/", omittingEmptySubsequences: false) {
        if segment.isEmpty { return nil }
        if segment.first == ".", let second = segment.dropFirst().first, operatorChars.contains(second) {
            return nil
        }
    }
    return id
}

/// `doc://<authority>/<prefix>(rest)` — for the design variant the prefix is
/// kept by the caller. nil when the scheme/authority/prefix shape doesn't match.
private func matchDocUri(_ id: String, segmentPrefix: String) -> String? {
    guard id.hasPrefix("doc://") else { return nil }
    let afterScheme = id.dropFirst("doc://".count)
    guard let slash = afterScheme.firstIndex(of: "/") else { return nil }
    let authority = afterScheme[..<slash]
    guard !authority.isEmpty else { return nil }
    let path = afterScheme[afterScheme.index(after: slash)...]
    guard path.hasPrefix(segmentPrefix) else { return nil }
    let rest = path.dropFirst(segmentPrefix.count)
    guard !rest.isEmpty else { return nil }
    return String(rest)
}

/// Type-directed section content decode (mirrors Enrichment's codec): TEXT
/// passes through; a BLOB with the 4-byte zstd magic is inflated; any other
/// BLOB is a best-effort UTF-8 decode; NULL → nil. Internal: the search-artifact
/// body-shard reader (SearchArtifacts.swift) streams sections through the same
/// codec.
func decodeSectionColumn(_ stmt: PreparedStatement, _ col: Int32) -> String? {
    switch stmt.columnType(col) {
        case SQLite.typeNull: return nil
        case SQLite.typeText: return stmt.text(col)
        default:
            guard let bytes = stmt.blob(col) else { return nil }
            if bytes.isEmpty { return "" }
            if bytes.count >= 4, bytes[0] == 0x28, bytes[1] == 0xB5, bytes[2] == 0x2F, bytes[3] == 0xFD,
                let inflated = ZstdDecoder.decompress(bytes)
            {
                return String(decoding: inflated, as: UTF8.self)
            }
            return String(decoding: bytes, as: UTF8.self)
    }
}

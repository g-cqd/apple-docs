import AemiJSONCore
import AppleDocsContent
import AppleDocsCore
import AppleDocsStorage
import OrderedCollections

/// Page resolution and metadata queries for ``DocumentLookup`` (Bun `getPage`, `searchByTitle`,
/// `getRelationshipCountsByType`).
extension DocumentLookup {
    struct Page {
        let document: DocumentRecord
        let rootSlug: String
        let frameworkDisplay: String
        /// Bun's `getPage` (path lookups) aliases `abstract`/`declaration`; `searchByTitle` rows do not, so
        /// symbol lookups omit those metadata keys.
        var hasTextAliases = true

        var header: BunMarkdownRenderer.Header {
            BunMarkdownRenderer.Header(
                key: document.key.rawValue,
                title: document.title,
                framework: frameworkDisplay,
                role: document.role,
                roleHeading: document.roleHeading,
                platformsJSON: document.platformsJSON
            )
        }
    }

    private static let pageSQL = """
        SELECT \(CorpusStore.documentColumnList), COALESCE(r.slug, d.framework), COALESCE(r.display_name, d.framework)
        FROM documents d LEFT JOIN roots r ON r.slug = d.framework
        """

    static func findPage(_ request: Request, on store: CorpusStore) throws(SQLiteError) -> Page? {
        if let path = request.path {
            if let page = try page(whereSQL: "d.key = ?", bindings: [.text(path)], on: store) { return page }
            if let canonical = AppleIdentifier.normalize(path), canonical != path {
                return try page(whereSQL: "d.key = ?", bindings: [.text(canonical)], on: store)
            }
            return nil
        }
        guard let symbol = request.symbol else { return nil }
        var found = try page(
            whereSQL: """
                d.title = ? COLLATE NOCASE AND (? IS NULL OR d.framework = ?)
                ORDER BY CASE WHEN d.role = 'symbol' OR d.kind = 'symbol' THEN 0 ELSE 1 END, length(d.key)
                LIMIT 1
                """,
            bindings: [.text(symbol), .optionalText(request.framework), .optionalText(request.framework)],
            on: store
        )
        found?.hasTextAliases = false
        return found
    }

    private static func page(
        whereSQL: String,
        bindings: [SQLiteValue],
        on store: CorpusStore
    ) throws(SQLiteError) -> Page? {
        guard let row = try store.connection.queryOne("\(pageSQL) WHERE \(whereSQL)", bindings: bindings) else {
            return nil
        }
        let count = CorpusStore.documentColumnCount
        return Page(
            document: try CorpusStore.decodeDocument(row),
            rootSlug: try row.text(at: count),
            frameworkDisplay: try row.text(at: count + 1)
        )
    }

    /// Bun's lookup `metadata` object.
    // @dl:disable -- Bun lookup metadata wire shape (field list, not shared logic)
    static func metadataObject(_ page: Page, on store: CorpusStore) throws(SQLiteError) -> JSONValue {
        let document = page.document
        var metadata: OrderedDictionary<String, JSONValue> = [
            "title": .string(document.title),
            "framework": .string(page.frameworkDisplay),
            "rootSlug": .string(page.rootSlug),
            "roleHeading": DocCValue.optional(document.roleHeading),
            "kind": DocCValue.optional(document.kind)
        ]
        if page.hasTextAliases { metadata["abstract"] = DocCValue.optional(document.abstractText) }
        metadata["platforms"] = page.hasTextAliases ? platforms(document.platformsJSON) : .array([])
        if page.hasTextAliases { metadata["declaration"] = DocCValue.optional(document.declarationText) }
        metadata["path"] = .string(document.key.rawValue)
        let counts = try relationshipCounts(document.key, on: store)
        if !counts.isEmpty { metadata["relationships"] = .object(counts) }
        if document.isDeprecated { metadata["isDeprecated"] = .bool(true) }
        if document.isBeta { metadata["isBeta"] = .bool(true) }
        return .object(metadata)
    }
    // @dl:enable

    private static func platforms(_ json: String?) -> JSONValue {
        guard let json, let root = try? AemiJSON.parse(Array(json.utf8)).root else { return .array([]) }
        return JSONValue(root)
    }

    /// `getRelationshipCountsByType`, keyed by Bun's camelCase names in query order.
    static func relationshipCounts(
        _ key: DocumentKey,
        on store: CorpusStore
    ) throws(SQLiteError) -> OrderedDictionary<String, JSONValue> {
        let rows = try store.connection.query(
            "SELECT relation_type, COUNT(*) FROM document_relationships WHERE from_key = ? GROUP BY relation_type",
            bindings: [.text(key.rawValue)]
        )
        var out: OrderedDictionary<String, JSONValue> = [:]
        for row in rows {
            let names = [
                "inherits_from": "inheritsFrom", "inherited_by": "inheritedBy", "conforms_to": "conformsTo",
                "see-also": "seeAlso", "see_also": "seeAlso", "seeAlso": "seeAlso", "child": "children"
            ]
            guard let name = names[try row.text(at: 0)] else { continue }
            let count = try row.integer(at: 1)
            if count > 0 { out[name] = .int(count) }
        }
        return out
    }
}

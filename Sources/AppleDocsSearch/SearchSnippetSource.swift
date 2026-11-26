import AppleDocsCore
import AppleDocsStorage

/// Snippet inputs and relationship counts for a page of results (Bun `getDocumentSnippetData` — document fields
/// plus the first 6 sections — and `getRelatedDocCounts`).
enum SearchSnippetSource {
    static func texts(for keys: [String], on connection: SQLiteConnection) -> [String: String] {
        let placeholders = SQLiteConnection.placeholders(keys.count)
        guard
            let documents = try? connection.query(
                "SELECT id, key, title, abstract_text, declaration_text, headings FROM documents WHERE key IN (\(placeholders))",
                bindings: keys.map(SQLiteValue.text)
            )
        else { return [:] }
        var sectionsByID: [Int64: [DocumentSectionRecord]] = [:]
        let ids = documents.compactMap { try? $0.integer(at: 0) }
        if !ids.isEmpty {
            let sql = """
                SELECT document_id, section_kind, heading, content_text, sort_order FROM (
                  SELECT document_id, section_kind, heading, content_text, sort_order,
                         ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY sort_order, id) AS rn
                  FROM document_sections WHERE document_id IN (\(SQLiteConnection.placeholders(ids.count)))
                ) WHERE rn <= 6
                ORDER BY document_id, sort_order
                """
            for row in (try? connection.query(sql, bindings: ids.map(SQLiteValue.integer))) ?? [] {
                guard let id = try? row.integer(at: 0), let kind = try? row.text(at: 1) else { continue }
                let text = (try? row.value(at: 3)).flatMap { try? ZstdCodec.decodeText(from: $0) } ?? nil
                sectionsByID[id, default: []]
                    .append(
                        DocumentSectionRecord(
                            sectionKind: kind,
                            heading: (try? row.optionalText(at: 2)) ?? nil,
                            contentText: text ?? "",
                            sortOrder: Int((try? row.integer(at: 4)) ?? 0)
                        )
                    )
            }
        }
        var out: [String: String] = [:]
        for row in documents {
            guard let id = try? row.integer(at: 0), let key = try? row.text(at: 1) else { continue }
            out[key] = DocumentPlainText.render(
                title: (try? row.optionalText(at: 2)) ?? nil,
                abstract: (try? row.optionalText(at: 3)) ?? nil,
                declaration: (try? row.optionalText(at: 4)) ?? nil,
                headings: (try? row.optionalText(at: 5)) ?? nil,
                sections: sectionsByID[id] ?? []
            )
        }
        return out
    }

    static func relatedCounts(for keys: [String], on connection: SQLiteConnection) -> [String: Int] {
        let placeholders = SQLiteConnection.placeholders(keys.count)
        let rows =
            (try? connection.query(
                "SELECT from_key, COUNT(*) FROM document_relationships WHERE from_key IN (\(placeholders)) GROUP BY from_key",
                bindings: keys.map(SQLiteValue.text)
            )) ?? []
        var out: [String: Int] = [:]
        for row in rows {
            if let key = try? row.text(at: 0), let count = try? row.integer(at: 1) { out[key] = Int(count) }
        }
        return out
    }
}

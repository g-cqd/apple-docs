import AemiJSONCore
import AppleDocsOutput
import AppleDocsStorage
import OrderedCollections

/// The static export's client-side search index: Bun's columnar title index (`search-artifacts.js`
/// `buildTitleIndex`, v2) restricted to the exported pages.
enum StaticSearchIndex {
    private struct Row {
        let key: String
        let title: String
        let abstract: String
        let framework: String?
        let kind: String
        let roleHeading: String
    }

    static func build(keys: [String], databasePath: String) throws -> String {
        let store = try CorpusStore(path: databasePath, options: .readOnly)
        defer { store.close() }
        // Batched key lookups keep memory proportional to the exported pages, not the whole corpus.
        var rows: [Row] = []
        rows.reserveCapacity(keys.count)
        let sorted = keys.sorted()
        for start in stride(from: 0, to: sorted.count, by: 500) {
            let batch = sorted[start ..< min(start + 500, sorted.count)]
            let placeholders = SQLiteConnection.placeholders(batch.count)
            let sqlRows = try store.connection.query(
                """
                SELECT key, title, abstract_text, framework, kind, role_heading FROM documents
                WHERE key IN (\(placeholders)) ORDER BY key
                """,
                bindings: batch.map(SQLiteValue.text)
            )
            for row in sqlRows {
                let abstract = try row.optionalText(at: 2) ?? ""
                rows.append(
                    Row(
                        key: try row.text(at: 0),
                        title: try row.text(at: 1),
                        abstract: String(decoding: Array(abstract.utf16.prefix(80)), as: UTF16.self),
                        framework: try row.optionalText(at: 3),
                        kind: try row.optionalText(at: 4) ?? "",
                        roleHeading: try row.optionalText(at: 5) ?? ""
                    )
                )
            }
        }
        let frameworks = Array(Set(rows.compactMap(\.framework))).sorted()
        let position = Dictionary(uniqueKeysWithValues: frameworks.enumerated().map { ($1, $0) })
        func column(_ value: (Row) -> String) -> JSONValue { .array(rows.map { .string(value($0)) }) }
        let object: OrderedDictionary<String, JSONValue> = [
            "v": .int(2),
            "frameworks": .array(frameworks.map(JSONValue.string)),
            "keys": column { String(WebDocPath.href($0.key).dropFirst("/doc/".count)) },
            "titles": column(\.title),
            "abstracts": column(\.abstract),
            "fwIndices": .array(rows.map { .int(Int64($0.framework.flatMap { position[$0] } ?? -1)) }),
            "kinds": column(\.kind),
            "roleHeadings": column(\.roleHeading)
        ]
        return JavaScriptJSON.stringify(.object(object))
    }
}

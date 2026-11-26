import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import AppleDocsStorage

extension StaticSiteBuilder {
    /// What to export: the selected frameworks and the page keys (framework landing pages first).
    struct ExportPlan: Sendable {
        let roots: [CorpusRootRecord]
        let frameworks: [PublicFrameworkSummary]
        let pageKeys: [String]

        static func load(databasePath: String, options: Options) throws(BuildError) -> ExportPlan {
            do {
                let store = try CorpusStore(path: databasePath, options: .readOnly)
                defer { store.close() }
                let roots = try store.listRoots()
                let selected = roots.filter { options.framework == nil || $0.slug == options.framework }
                let rows: [SQLiteRow] =
                    if let framework = options.framework {
                        try store.connection.query(
                            "SELECT key FROM documents WHERE framework = ? ORDER BY url_depth ASC, key ASC LIMIT ?",
                            bindings: [.text(framework), .integer(Int64(options.limit))]
                        )
                    } else {
                        try store.connection.query(
                            "SELECT key FROM documents ORDER BY url_depth ASC, key ASC LIMIT ?",
                            bindings: [.integer(Int64(options.limit))]
                        )
                    }
                let documentKeys = try rows.map { row throws(SQLiteError) in try row.text(at: 0) }
                let known = Set(documentKeys)
                let landing = selected.map(\.slug).filter { !known.contains($0) && (try? DocumentKey($0)) != nil }
                return ExportPlan(
                    roots: roots,
                    frameworks: selected.map(PublicFrameworkSummary.init),
                    pageKeys: landing + documentKeys
                )
            } catch {
                throw .database("\(error)")
            }
        }
    }
}

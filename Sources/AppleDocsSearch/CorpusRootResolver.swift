public import AppleDocsStorage

/// Bun's `resolveRoot`: exact slug, then case-insensitive slug, display-name substring, slug substring.
public enum CorpusRootResolver {
    /// A resolved documentation root.
    public struct Root: Sendable, Equatable {
        public let slug: String
        public let displayName: String
        public let kind: String
        public let sourceType: String
    }

    public static func resolve(_ input: String, on connection: SQLiteConnection) throws(SQLiteError) -> Root? {
        var roots: [Root] = []
        for row in try connection.query("SELECT slug, display_name, kind, source_type FROM roots ORDER BY slug") {
            roots.append(
                Root(
                    slug: try row.text(at: 0),
                    displayName: try row.text(at: 1),
                    kind: try row.text(at: 2),
                    sourceType: try row.text(at: 3)
                )
            )
        }
        let lower = input.lowercased()
        return roots.first { $0.slug == input } ?? roots.first { $0.slug.lowercased() == lower }
            ?? roots.first { $0.displayName.lowercased().contains(lower) } ?? roots.first { $0.slug.contains(lower) }
    }
}

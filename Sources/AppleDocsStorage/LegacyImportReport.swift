/// Summary counts produced by ``LegacyV31Importer`` after migrating a Bun v31 corpus.
public struct LegacyImportReport: Hashable, Sendable {
    /// Table names tracked in ``tableCounts``.
    public enum Table: String, Hashable, Sendable, CaseIterable {
        case roots
        case documents
        case sections = "document_sections"
        case relationships = "document_relationships"
        case sfSymbols = "sf_symbols"
        case fontFamilies = "apple_font_families"
        case fontFiles = "apple_font_files"
        case vectors = "document_vectors"
        case chunks = "document_chunks"
    }

    public let sourceSchemaVersion: Int
    public let tableCounts: [Table: Int]

    public init(sourceSchemaVersion: Int, tableCounts: [Table: Int]) {
        self.sourceSchemaVersion = sourceSchemaVersion
        self.tableCounts = tableCounts
    }

    /// Returns the number of rows imported for `table`.
    public subscript(_ table: Table) -> Int {
        tableCounts[table] ?? 0
    }
}

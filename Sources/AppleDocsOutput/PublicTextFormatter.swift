/// Tabular plain-text formatter shared by CLI query subcommands.
public enum PublicTextFormatter: Sendable {
    /// Renders rows of tab-separated columns separated by newlines.
    public static func renderTable(_ rows: [[String]]) -> String {
        rows.map { $0.joined(separator: "\t") }.joined(separator: "\n")
    }

    /// Formats search hits as `path\ttitle\t[confidence]`.
    public static func formatSearchResults(_ results: [PublicSearchResult]) -> String {
        renderTable(results.map { [$0.path, $0.title, "[\($0.confidence)]"] })
    }

    /// Formats root summaries as `slug\tdisplayName\t(pageCount)`.
    public static func formatFrameworks(_ roots: [PublicFrameworkSummary]) -> String {
        renderTable(roots.map { [$0.slug, $0.displayName, "(\($0.pageCount))"] })
    }
}

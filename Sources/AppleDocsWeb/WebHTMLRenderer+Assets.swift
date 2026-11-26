public import AppleDocsOutput

extension WebHTMLRenderer {
    /// Renders `/symbols`: a search form and a grid of SF Symbols previewed through `/symbols/<scope>/<name>.svg`.
    public static func renderSymbolsPage(query: String, scope: String, symbols: [PublicSFSymbol]) -> String {
        let items = symbols.map { symbol in
            let name = escapeHTML(symbol.name)
            let src = "/symbols/\(escapeHTML(symbol.scope))/\(name).svg"
            return "<li><figure><img src=\"\(src)\" alt=\"\" loading=\"lazy\" width=\"40\" height=\"40\">"
                + "<figcaption>\(name)</figcaption></figure></li>"
        }
        let summary = symbols.isEmpty ? "<p class=\"muted\">No symbols found.</p>" : ""
        let scopeNote = scope == "private" ? "<p class=\"meta\">Private symbols</p>" : ""
        let body =
            "<h1>SF Symbols</h1>\(scopeNote)"
            + searchForm(query: query, action: "/symbols", placeholder: "Search symbols")
            + summary + "<ul class=\"symbol-grid\">\(items.joined())</ul>"
        return page(title: "SF Symbols — apple-docs", body: body)
    }

    /// Renders `/fonts`: every Apple font family with its files.
    public static func renderFontsPage(families: [PublicAppleFontFamily]) -> String {
        let blocks = families.map { family in
            let files = family.files.map { file in
                let style = file.styleName.map { " — \(escapeHTML($0))" } ?? ""
                return "<li><code>\(escapeHTML(file.fileName))</code>\(style)</li>"
            }
            let category = family.category.map { "<span class=\"badge\">\(escapeHTML($0))</span>" } ?? ""
            return "<section class=\"font-family\"><h2>\(escapeHTML(family.displayName))\(category)</h2>"
                + "<p class=\"meta\">\(family.files.count) files · \(escapeHTML(family.status))</p>"
                + "<ul>\(files.joined())</ul></section>"
        }
        let empty =
            families.isEmpty ? "<p class=\"muted\">No fonts installed. Run <code>apple-docs setup</code>.</p>" : ""
        return page(title: "Fonts — apple-docs", body: "<h1>Apple Fonts</h1>\(empty)\(blocks.joined(separator: "\n"))")
    }
}

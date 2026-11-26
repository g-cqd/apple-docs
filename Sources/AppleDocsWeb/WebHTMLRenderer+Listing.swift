public import AppleDocsOutput

extension WebHTMLRenderer {
    /// Renders the landing page: frameworks and collections grouped by kind.
    public static func renderIndexPage(frameworks: [PublicFrameworkSummary]) -> String {
        var order: [String] = []
        var groups: [String: [PublicFrameworkSummary]] = [:]
        for item in frameworks {
            if groups[item.kind] == nil { order.append(item.kind) }
            groups[item.kind, default: []].append(item)
        }
        let sections = order.sorted()
            .map { kind in
                let items = (groups[kind] ?? [])
                    .map { item in
                        let count = item.pageCount > 0 ? "<span class=\"badge\">\(item.pageCount)</span>" : ""
                        return
                            "<li><a href=\"/doc/\(escapeHTML(item.slug))\">\(escapeHTML(item.displayName))</a>\(count)</li>"
                    }
                return "<h2>\(escapeHTML(heading(forKind: kind)))</h2><ul class=\"link-list\">\(items.joined())</ul>"
            }
        let body =
            "<h1>Apple Documentation</h1><p class=\"muted\">\(frameworks.count) collections available offline.</p>"
            + searchForm(query: "") + sections.joined(separator: "\n")
        return page(title: "apple-docs", description: "Offline Apple developer documentation.", body: body)
    }

    /// Renders `/search`: the query form and linked results (an empty query shows the form only).
    public static func renderSearchPage(query: String, results: [PublicSearchResult]) -> String {
        var body = "<h1>Search</h1>" + searchForm(query: query)
        if !query.isEmpty {
            if results.isEmpty {
                body += "<p class=\"muted\">No results for “\(escapeHTML(query))”.</p>"
            } else {
                let items = results.map { result in
                    let doc = result.document
                    let abstract = doc.abstract.map { "<p>\(WebMarkdownBlockRenderer.renderInline($0))</p>" } ?? ""
                    return
                        "<li><a href=\"/doc/\(escapeHTML(WebDocPath.safeKey(doc.path)))\">\(escapeHTML(doc.title))</a>"
                        + "<span class=\"badge\">\(escapeHTML(doc.framework))</span>\(abstract)</li>"
                }
                body += "<ul class=\"results\">\(items.joined())</ul>"
            }
        }
        let title = query.isEmpty ? "Search — apple-docs" : "\(query) — Search — apple-docs"
        return page(title: title, body: body)
    }

    /// Renders the static-export `/search` page: the form plus a results list filled client-side from the
    /// prebuilt title index at `indexPath` (`app.js`).
    public static func renderStaticSearchPage(indexPath: String) -> String {
        let body =
            "<h1>Search</h1>" + searchForm(query: "")
            + "<ul class=\"results\" data-static-search=\"\(escapeHTML(indexPath))\" aria-live=\"polite\"></ul>"
        return page(title: "Search — apple-docs", body: body)
    }

    static func searchForm(query: String, action: String = "/search", placeholder: String = "Search documentation")
        -> String
    {
        """
        <form class="search-form" action="\(escapeHTML(action))" method="get" role="search">\
        <input type="search" name="q" value="\(escapeHTML(query))" placeholder="\(escapeHTML(placeholder))" \
        aria-label="\(escapeHTML(placeholder))"><button type="submit">Search</button></form>
        """
    }

    private static func heading(forKind kind: String) -> String {
        switch kind {
            case "framework": "Frameworks"
            case "collection": "Collections"
            case "tooling": "Tools"
            case "guidelines": "Guidelines"
            case "design": "Design"
            case "release-notes": "Release Notes"
            case "technology": "Technologies"
            default: kind.prefix(1).uppercased() + kind.dropFirst()
        }
    }
}

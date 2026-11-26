import AppleDocsContent
import AppleDocsCore
import AppleDocsOutput

extension WebHTMLRenderer {
    /// Renders a `/doc/<key>` page: breadcrumbs, metadata, sections (link groups resolved to pages), and children.
    public static func renderDocumentPage(_ view: WebDocumentView) -> String {
        var parts: [String] = [breadcrumbs(trail(for: view))]
        var groups = WebLinkGroups(view.related)
        if let detail = view.detail {
            parts.append(contentsOf: header(detail, frameworkName: view.frameworkName))
            for section in view.sections {
                parts.append(render(section, groups: &groups))
            }
        } else {
            parts.append("<h1>\(escapeHTML(view.frameworkName))</h1>")
            if let count = view.framework?.pageCount, count > 0 {
                parts.append("<p class=\"meta\">\(count) pages</p>")
            }
        }
        for category in WebLinkGroups.Category.allCases {
            parts.append(linkSection(heading: category.defaultHeading, groups.take(category)))
        }
        if !view.children.isEmpty {
            let heading = view.detail == nil ? "Contents" : "In This Section"
            parts.append(
                "<section><h2>\(heading)</h2>\(linkList(view.children.map { ($0.path, $0.title) }))</section>"
            )
        }
        return page(
            title: "\(view.title) — \(view.frameworkName) — apple-docs",
            description: view.detail?.document.abstract,
            body: parts.filter { !$0.isEmpty }.joined(separator: "\n")
        )
    }

    private static func render(_ section: WebDocumentSection, groups: inout WebLinkGroups) -> String {
        let heading = section.heading.flatMap { $0.isEmpty ? nil : $0 }
        if let category = WebLinkGroups.Category(sectionKind: section.kind), groups.has(category) {
            return linkSection(heading: heading ?? category.defaultHeading, groups.take(category))
        }
        var body: String
        if section.kind == "mentioned_in", let json = section.contentJSON {
            let links = StoredSectionContent.links(contentJSON: json)
            body = links.isEmpty ? "" : linkList(links.map { ($0.key, $0.title) })
        } else {
            body = ""
        }
        if body.isEmpty {
            let markdown = section.contentJSON.flatMap(StoredSectionContent.markdown(contentJSON:)) ?? section.content
            body = WebMarkdownBlockRenderer.render(markdown)
        }
        let title = heading.map { "<h2>\(escapeHTML($0))</h2>" } ?? ""
        return "<section>\(title)\(body)</section>"
    }

    private static func linkSection(heading: String, _ groups: [(title: String?, items: [PublicRelatedDocument])])
        -> String
    {
        guard !groups.isEmpty else { return "" }
        let blocks = groups.map { group in
            let title = group.title.map { "<h3>\(escapeHTML($0))</h3>" } ?? ""
            let items = group.items.map { item in
                item.isAvailable
                    ? "<li><a href=\"/doc/\(escapeHTML(item.path))\">\(escapeHTML(item.title))</a></li>"
                    : "<li>\(escapeHTML(item.title))</li>"
            }
            return "\(title)<ul class=\"link-list\">\(items.joined())</ul>"
        }
        return "<section class=\"links\"><h2>\(escapeHTML(heading))</h2>\(blocks.joined())</section>"
    }

    private static func trail(for view: WebDocumentView) -> [(label: String, href: String?)] {
        let segments = view.key.rawValue.split(separator: "/").map(String.init)
        var crumbs: [(label: String, href: String?)] = [("Home", "/")]
        guard segments.count > 1 else {
            crumbs.append((view.frameworkName, nil))
            return crumbs
        }
        crumbs.append((view.frameworkName, "/doc/\(segments[0])"))
        for index in 1 ..< (segments.count - 1) {
            crumbs.append((segments[index], "/doc/" + segments[0 ... index].joined(separator: "/")))
        }
        crumbs.append((view.title, nil))
        return crumbs
    }

    private static func header(_ detail: PublicDocumentDetail, frameworkName: String) -> [String] {
        let document = detail.document
        let role = document.roleHeading.map { "\(escapeHTML($0)) · " } ?? ""
        var parts = [
            "<p class=\"meta\">\(role)\(escapeHTML(frameworkName))</p>",
            "<h1>\(escapeHTML(document.title))</h1>"
        ]
        if let abstract = document.abstract, !abstract.isEmpty {
            parts.append("<p class=\"abstract\">\(WebMarkdownBlockRenderer.renderInline(abstract))</p>")
        }
        if let declaration = document.declaration, !declaration.isEmpty {
            parts.append("<pre><code class=\"language-swift\">\(escapeHTML(declaration))</code></pre>")
        }
        return parts
    }
}

// The doc page's relationship sidebar + table-of-contents — port of
// `src/web/templates/_doc-content.js`. The TOC ids reuse `RenderHelpers.slugify`
// so they match the `<section id>` anchors the content renderer emits.

import ADBase
import ADContent
import ADJSONCore

enum DocSidebar {
    private static func esc(_ s: String) -> String { WebHtml.escape(s) }

    /// One TOC entry: a section anchor id + its label.
    struct TocItem: Equatable, Sendable {
        let id: String
        let label: String
    }

    /// buildRelationshipContent(section) — the "Relationships" sidebar block.
    static func buildRelationshipContent(_ section: DocSection) -> String {
        let groups = elements(parse(section.contentJson))
        var parts: [String] = ["<h2>Relationships</h2>"]

        if !groups.isEmpty {
            for group in groups {
                if let t = group.member("title"), t.isTruthy {
                    parts.append("<h3 class=\"sidebar-group-title\">\(esc(coerce(t)))</h3>")
                }
                var items = ""
                for item in elements(group.member("items")) {
                    if let key = item.member("key"), key.isTruthy {
                        items +=
                            "<li><a href=\"/docs/\(esc(SafePath.safeWebDocKey(coerce(key))))/\"><code>\(esc(coerceOr(item.member("title"), coerce(key))))</code></a></li>"
                    } else {
                        items += "<li>\(esc(coerceOr(item.member("title"), coerce(item.member("identifier")))))</li>"
                    }
                }
                if !items.isEmpty { parts.append("<ul class=\"sidebar-list\">\(items)</ul>") }
            }
        } else {
            parts.append("<p class=\"sidebar-hint\">See relationships section in the article.</p>")
        }
        return parts.joined(separator: "\n  ")
    }

    /// buildPageToc(sections) — TOC items, skipping abstract / empty / empty-link
    /// sections (relationships render in the sidebar, not the TOC).
    static func buildPageToc(_ sections: [DocSection]) -> [TocItem] {
        var items: [TocItem] = []
        for section in sections {
            let kind = section.sectionKind ?? ""
            if kind == "abstract" { continue }

            let hasText = (section.contentText?.contains { !$0.isWhitespace }) ?? false
            let json = section.contentJson
            let hasJson = json.map { $0.contains { !$0.isWhitespace } } ?? false
            if !hasText && !hasJson { continue }

            if kind == "topics" || kind == "relationships" || kind == "see_also" {
                if !hasRenderableItems(json) { continue }
            }

            let id: String
            let label: String
            switch kind {
            case "declaration": id = "declaration"; label = "Declaration"
            case "parameters": id = "parameters"; label = "Parameters"
            case "properties": label = section.heading ?? "Properties"; id = RenderHelpers.slugify(label)
            case "rest_endpoint": label = section.heading ?? "URL"; id = RenderHelpers.slugify(label)
            case "rest_parameters": label = section.heading ?? "Parameters"; id = RenderHelpers.slugify(label)
            case "rest_responses": label = section.heading ?? "Response Codes"; id = RenderHelpers.slugify(label)
            case "possible_values": label = section.heading ?? "Possible Values"; id = RenderHelpers.slugify(label)
            case "mentioned_in": id = "mentioned-in"; label = "Mentioned in"
            case "discussion": label = section.heading ?? "Overview"; id = RenderHelpers.slugify(label)
            case "topics": id = "topics"; label = "Topics"
            case "relationships": continue  // sidebar, not the article body
            case "see_also": id = "see-also"; label = "See Also"
            default: label = section.heading ?? "Section"; id = RenderHelpers.slugify(label)
            }
            if !id.isEmpty { items.append(TocItem(id: id, label: label)) }
        }
        return items
    }

    /// hasRenderableItems(json) — true when a parsed link-section has ≥1 item.
    static func hasRenderableItems(_ json: String?) -> Bool {
        for group in elements(parse(json)) where !elements(group.member("items")).isEmpty { return true }
        return false
    }

    /// renderTocHtml(tocItems, mobile) — "" for fewer than 2 entries.
    static func renderTocHtml(_ items: [TocItem], mobile: Bool = false) -> String {
        if items.count < 2 { return "" }
        let list = items.map { "<li><a href=\"#\(esc($0.id))\">\(esc($0.label))</a></li>" }.joined()
        let listHtml = "<ul>\(list)</ul>"
        if mobile {
            return "<details class=\"page-toc-mobile\"><summary>Contents</summary><nav class=\"page-toc\">\(listHtml)</nav></details>"
        }
        return "<nav class=\"page-toc\">\(listHtml)</nav>"
    }

    // MARK: - helpers

    private static func parse(_ s: String?) -> JSON? {
        guard let s, !s.isEmpty else { return nil }
        return try? ADJSON.parse(s, options: .init(maxDepth: 512)).root
    }

    private static func coerce(_ node: JSON?) -> String {
        guard let node, !node.isNull else { return "" }
        return node.string ?? node.jsString
    }

    private static func coerceOr(_ node: JSON?, _ fallback: String) -> String {
        guard let node, !node.isNull else { return fallback }
        return node.string ?? node.jsString
    }

    private static func elements(_ node: JSON?) -> [JSON] {
        guard let node, node.isArray else { return [] }
        var out: [JSON] = []
        node.forEachElement { out.append($0) }
        return out
    }
}

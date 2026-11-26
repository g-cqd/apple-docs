import AemiJSONCore
import Foundation

/// Renders DocC block and inline render-node trees into compact Markdown-flavoured text.
///
/// Mirrors the Bun `normalize/render-content.js` coverage (paragraphs, headings, code listings, ordered and
/// unordered lists, asides, tables, link groups, and every inline style) and resolves `reference` nodes through
/// the page's `references` map so prose shows human titles instead of raw `doc://` identifiers. Recursion is
/// capped at 512 levels (the same bound as the Bun renderer) so hostile payloads cannot overflow the stack.
enum DocCContentRenderer {
    static let maxDepth = 512

    /// Renders an array of block nodes, optionally skipping the first heading (already used as a section title).
    static func renderBlocks(_ nodes: [JSON], refs: JSON, skippingFirstHeading: Bool = false, depth: Int = 0) -> String
    {
        guard depth <= maxDepth else { return "" }
        var parts: [String] = []
        var skipped = !skippingFirstHeading
        for node in nodes {
            if !skipped, node["type"].string == "heading" {
                skipped = true
                continue
            }
            let rendered = renderBlock(node, refs: refs, depth: depth)
            if !rendered.isEmpty { parts.append(rendered) }
        }
        return parts.joined(separator: "\n\n")
    }

    /// Renders an array of inline nodes into a single line of text.
    static func renderInline(_ node: JSON, refs: JSON, depth: Int = 0) -> String {
        guard depth <= maxDepth, let items = node.array else { return "" }
        return items.map { renderInlineNode($0, refs: refs, depth: depth + 1) }.joined()
    }

    /// Returns the display title for a DocC reference identifier.
    static func referenceTitle(_ identifier: String, refs: JSON) -> String {
        if let title = refs[identifier]["title"].string, !title.isEmpty { return title }
        let trimmed = identifier.split(separator: "/").last.map(String.init) ?? identifier
        return trimmed.isEmpty ? identifier : trimmed
    }

    /// First heading text in `nodes`, if any.
    static func firstHeading(_ nodes: [JSON], refs: JSON) -> String? {
        for node in nodes where node["type"].string == "heading" {
            let text = node["text"].string ?? renderInline(node["inlineContent"], refs: refs)
            return text.isEmpty ? nil : text
        }
        return nil
    }

    private static func renderBlock(_ node: JSON, refs: JSON, depth: Int) -> String {
        let next = depth + 1
        switch node["type"].string ?? "" {
            case "paragraph":
                return renderInline(node["inlineContent"], refs: refs, depth: next)
            case "heading":
                let text = node["text"].string ?? renderInline(node["inlineContent"], refs: refs, depth: next)
                return text.isEmpty ? "" : "### \(text)"
            case "codeListing":
                let code = (node["code"].array ?? []).compactMap(\.string).joined(separator: "\n")
                return code.isEmpty ? "" : "```\(node["syntax"].string ?? "")\n\(code)\n```"
            case "unorderedList", "orderedList":
                return renderList(node, refs: refs, depth: next)
            case "aside":
                let style = (node["name"].string ?? node["style"].string ?? "note").capitalized
                let inner = renderBlocks(node["content"].array ?? [], refs: refs, depth: next)
                return inner.isEmpty ? "" : "> **\(style):** \(inner)"
            case "table":
                return renderTable(node, refs: refs, depth: next)
            case "links":
                return (node["items"].array ?? []).compactMap(\.string)
                    .map { "- \(referenceTitle($0, refs: refs))" }
                    .joined(separator: "\n")
            default:
                if node["inlineContent"].array != nil {
                    return renderInline(node["inlineContent"], refs: refs, depth: next)
                }
                if let content = node["content"].array {
                    return renderBlocks(content, refs: refs, depth: next)
                }
                return node["text"].string ?? node["code"].string ?? ""
        }
    }

    private static func renderList(_ node: JSON, refs: JSON, depth: Int) -> String {
        let ordered = node["type"].string == "orderedList"
        let items = node["items"].array ?? []
        return items.enumerated()
            .map { index, item in
                let body = renderBlocks(item["content"].array ?? [], refs: refs, depth: depth)
                    .replacing("\n\n", with: " ")
                return ordered ? "\(index + 1). \(body)" : "- \(body)"
            }
            .joined(separator: "\n")
    }

    private static func renderTable(_ node: JSON, refs: JSON, depth: Int) -> String {
        (node["rows"].array ?? [])
            .map { row in
                let cells = row.array ?? row["cells"].array ?? []
                return
                    cells
                    .map { renderBlocks($0["content"].array ?? $0.array ?? [], refs: refs, depth: depth) }
                    .joined(separator: " | ")
            }
            .joined(separator: "\n")
    }

    private static func renderInlineNode(_ node: JSON, refs: JSON, depth: Int) -> String {
        switch node["type"].string ?? "" {
            case "text":
                return node["text"].string ?? ""
            case "codeVoice":
                return node["code"].string.map { "`\($0)`" } ?? ""
            case "emphasis":
                return "*\(renderInline(node["inlineContent"], refs: refs, depth: depth))*"
            case "strong", "inlineHead":
                return "**\(renderInline(node["inlineContent"], refs: refs, depth: depth))**"
            case "newTerm", "superscript", "subscript", "strikethrough":
                return renderInline(node["inlineContent"], refs: refs, depth: depth)
            case "reference":
                if let override = node["overridingTitle"].string { return override }
                return node["identifier"].string.map { referenceTitle($0, refs: refs) } ?? ""
            case "link":
                return node["title"].string ?? node["destination"].string ?? ""
            default:
                return node["text"].string ?? node["code"].string ?? ""
        }
    }
}

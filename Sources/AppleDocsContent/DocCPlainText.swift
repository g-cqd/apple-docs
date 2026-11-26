import AemiJSONCore
import AppleDocsCore

/// Plain-text rendering of DocC block and inline nodes — a byte-compatible port of Bun's
/// `normalize/render-content.js` (`renderContentNodesToText`, `renderInlineNodes`). This is what both
/// pipelines store in `content_text` / `abstract_text` and index for full-text search. Recursion is capped at
/// 512 levels, beyond which a subtree renders empty (same bound as Bun).
enum DocCPlainText {
    static let maxDepth = 512
    private static let inlineContainers: Set<String> = [
        "emphasis", "strong", "newTerm", "inlineHead", "superscript", "subscript", "strikethrough"
    ]

    /// `renderContentNodesToText(nodes, refs)`.
    static func blocks(_ nodes: JSON, refs: JSON, depth: Int = 0) -> String {
        joined(nodes, depth: depth) { block($0, refs: refs, depth: depth) }
    }

    /// `renderInlineNodes(nodes, refs)`.
    static func inline(_ nodes: JSON, refs: JSON, depth: Int = 0) -> String {
        joined(nodes, depth: depth) { inlineNode($0, refs: refs, depth: depth) }
    }

    private static func joined(_ nodes: JSON, depth: Int, render: (JSON) -> String) -> String {
        guard depth <= maxDepth, let items = nodes.array else { return "" }
        var out = ""
        for node in items { out += render(node) }
        return out
    }

    /// Title for a reference identifier: the references map title, else the normalized identifier, else the id.
    static func referenceTitle(_ identifier: String, refs: JSON) -> String {
        refs[identifier]["title"].string ?? AppleIdentifier.normalize(identifier) ?? identifier
    }

    private static func block(_ node: JSON, refs: JSON, depth: Int) -> String {
        guard node.isObject else { return "" }
        switch node["type"].string ?? "" {
            case "paragraph":
                return inline(node["inlineContent"], refs: refs, depth: depth + 1) + "\n"
            case "heading":
                return (node["text"].string ?? inline(node["inlineContent"], refs: refs, depth: depth + 1)) + "\n"
            case "codeListing":
                return (node["code"].array ?? []).map { $0.string ?? "" }.joined(separator: "\n") + "\n"
            case "unorderedList", "orderedList":
                return (node["items"].array ?? []).map { blocks($0["content"], refs: refs, depth: depth + 1) }.joined()
            case "aside":
                let style = node["style"].string ?? "Note"
                let inner = trimmed(blocks(node["content"], refs: refs, depth: depth + 1))
                return "\(style): \(inner)\n"
            case "table":
                return table(node, refs: refs, depth: depth) + "\n"
            case "links":
                let titles = (node["items"].array ?? [])
                    .map { item in
                        item.string.map { referenceTitle($0, refs: refs) } ?? ""
                    }
                return titles.joined(separator: "\n") + "\n"
            default:
                return inlineNodeOrFallback(node, refs: refs, depth: depth)
        }
    }

    private static func table(_ node: JSON, refs: JSON, depth: Int) -> String {
        (node["rows"].array ?? [])
            .map { row in
                let cells = row.isArray ? (row.array ?? []) : (row["cells"].array ?? [])
                return cells.map { trimmed(blocks($0["content"], refs: refs, depth: depth + 1)) }
                    .joined(separator: " | ")
            }
            .joined(separator: "\n")
    }

    /// Inline node types inside a block walk, then Bun's best-effort fallback (text, code, children).
    private static func inlineNodeOrFallback(_ node: JSON, refs: JSON, depth: Int) -> String {
        let type = node["type"].string ?? ""
        if ["text", "codeVoice", "reference", "link"].contains(type) || inlineContainers.contains(type) {
            return inlineNode(node, refs: refs, depth: depth)
        }
        if let text = node["text"].string, !text.isEmpty { return text }
        if let code = node["code"].string, !code.isEmpty { return code }
        if let codeLines = node["code"].array, !codeLines.isEmpty {
            return codeLines.map { $0.string ?? "" }.joined(separator: ",")
        }
        if node["inlineContent"].isArray { return inline(node["inlineContent"], refs: refs, depth: depth + 1) }
        if node["content"].isArray { return blocks(node["content"], refs: refs, depth: depth + 1) }
        return ""
    }

    private static func inlineNode(_ node: JSON, refs: JSON, depth: Int) -> String {
        let type = node["type"].string ?? ""
        switch type {
            case "text": return node["text"].string ?? ""
            case "codeVoice": return node["code"].string ?? ""
            case "reference":
                let identifier = node["identifier"].string
                return identifier.flatMap { refs[$0]["title"].string } ?? node["title"].string ?? identifier ?? ""
            case "link":
                return node["title"].string ?? node["destination"].string ?? ""
            default:
                if inlineContainers.contains(type) {
                    return inline(node["inlineContent"], refs: refs, depth: depth + 1)
                }
                return node["text"].string ?? node["code"].string ?? ""
        }
    }

    /// JavaScript `String.prototype.trim()` (shared with the body index).
    static func trimmed(_ text: String) -> String { DocumentPlainText.trim(text) }
}

// DocC content-node → HTML rendering — native port of
// `src/content/render-html/nodes.js`. Walks the structured `contentJson` node
// tree (the same shape ContentText / PageMarkdown walk) and emits HTML. Block
// and inline handlers call into each other through every level, so they live in
// one type. String-building (not the ByteWriter) to stay 1:1 with the JS for
// parity; this runs at build time, not on the request hot path.

import ADBase
import ADJSONCore

/// The code-highlighter seam (the shiki coprocess in production): `(code, language)`
/// → highlighted HTML, or `nil` to fall back to a plain `<pre><code>`.
public typealias CodeHighlight = @Sendable (_ code: String, _ language: String) -> String?

struct HtmlNodes: Sendable {
    let highlight: CodeHighlight?

    /// Mirrors the Swift renderer's `parse(maxDepth: 512)` bound (see nodes.js).
    static let maxRenderDepth = 512

    init(highlight: CodeHighlight? = nil) { self.highlight = highlight }

    // MARK: - block level

    /// renderContentNodesToHtml: each block node concatenated.
    func renderNodes(_ nodes: JSON?, _ depth: Int = 0) -> String {
        guard let nodes, nodes.isArray, depth <= Self.maxRenderDepth else { return "" }
        var out = ""
        nodes.forEachElement { out += renderBlock($0, depth) }
        return out
    }

    /// Overload for a pre-collected Swift array (e.g. `skipDuplicateHeading` output).
    func renderNodes(_ nodes: [JSON], _ depth: Int = 0) -> String {
        guard depth <= Self.maxRenderDepth else { return "" }
        var out = ""
        for node in nodes { out += renderBlock(node, depth) }
        return out
    }

    func renderBlock(_ node: JSON, _ depth: Int) -> String {
        guard node.isObject else { return "" }
        let type = node.member("type")

        if eq(type, "paragraph") {
            return "<p>\(renderInlines(node.member("inlineContent"), depth + 1))</p>"
        }
        if eq(type, "heading") {
            let level = clamp(Int(node.member("level")?.double ?? 3), 2, 6)
            let textNode = node.member("text")
            let text =
                (textNode != nil && !(textNode!.isNull))
                ? coerce(textNode) : renderInlines(node.member("inlineContent"), depth + 1)
            let anchorNode = node.member("anchor")
            let anchor =
                (anchorNode != nil && !(anchorNode!.isNull))
                ? " id=\"\(esc(coerce(anchorNode)))\"" : ""
            return "<h\(level)\(anchor)>\(esc(text))</h\(level)>"
        }
        if eq(type, "codeListing") {
            let lang = (node.member("syntax").map { !$0.isNull } ?? false) ? coerce(node.member("syntax")) : "swift"
            let code = joinLines(node.member("code"))
            if let highlight, let result = highlight(code, lang) { return result }
            return "<pre><code class=\"language-\(esc(lang))\">\(esc(code))</code></pre>"
        }
        if eq(type, "unorderedList") { return list("ul", node, depth) }
        if eq(type, "orderedList") { return list("ol", node, depth) }
        if eq(type, "aside") {
            let style = (node.member("style").map { !$0.isNull } ?? false) ? coerce(node.member("style")) : "Note"
            let inner = renderNodes(node.member("content"), depth + 1)
            return "<aside><p><strong>\(esc(style)):</strong></p>\(inner)</aside>"
        }
        if eq(type, "table") { return table(node, depth) }
        if eq(type, "links") { return linksBlock(node) }
        if eq(type, "termList") {
            var out = "<dl>"
            forEach(node.member("items")) { item in
                let term =
                    (item.member("term") != nil)
                    ? renderInlines(item.member("term")?.member("inlineContent"), depth + 1) : ""
                let def = renderNodes(item.member("definition")?.member("content"), depth + 1)
                out += "<dt>\(term)</dt><dd>\(def)</dd>"
            }
            return out + "</dl>"
        }

        // default: an inline node at block level → wrap in <p>
        if eq(type, "text") || eq(type, "codeVoice") || eq(type, "emphasis") || eq(type, "strong")
            || eq(type, "reference") || eq(type, "link")
        {
            return "<p>\(renderInline(node, depth + 1))</p>"
        }
        if let content = node.member("content"), content.isArray {
            return renderNodes(content, depth + 1)
        }
        if let inline = node.member("inlineContent"), inline.isArray {
            return "<p>\(renderInlines(inline, depth + 1))</p>"
        }
        if let text = node.member("text"), !text.isNull, text.isTruthy {
            return "<p>\(esc(coerce(text)))</p>"
        }
        return ""
    }

    private func list(_ tag: String, _ node: JSON, _ depth: Int) -> String {
        var out = "<\(tag)>"
        forEach(node.member("items")) { item in
            out += "<li>\(renderNodes(item.member("content"), depth + 1))</li>"
        }
        return out + "</\(tag)>"
    }

    private func table(_ node: JSON, _ depth: Int) -> String {
        let headerStyle = (node.member("header").map { !$0.isNull } ?? false) ? coerce(node.member("header")) : "none"
        let rows = elements(node.member("rows"))
        if rows.isEmpty { return "" }
        var parts = "<table>"
        for i in rows.indices {
            let row = rows[i]
            let cells = row.isArray ? elements(row) : elements(row.member("cells"))
            let isHeader = (headerStyle == "row" && i == 0) || (headerStyle == "both" && i == 0)
            let tag = isHeader ? "th" : "td"
            let wrapper = isHeader ? "thead" : (i == 1 && headerStyle != "none" ? "tbody" : "")
            if wrapper == "thead" { parts += "<thead>" }
            if wrapper == "tbody" { parts += "<tbody>" }
            parts += "<tr>"
            for cell in cells {
                let content =
                    cell.member("content") != nil
                    ? renderNodes(cell.member("content"), depth + 1) : renderNodes(cell, depth + 1)
                parts += "<\(tag)>\(content)</\(tag)>"
            }
            parts += "</tr>"
            if wrapper == "thead" { parts += "</thead>" }
        }
        if headerStyle != "none" && rows.count > 1 { parts += "</tbody>" }
        return parts + "</table>"
    }

    private func linksBlock(_ node: JSON) -> String {
        var out = "<ul>"
        forEach(node.member("items")) { item in
            if item.isObject, let rk = item.member("_resolvedKey"), rk.isTruthy {
                let key = coerce(rk)
                let title = resolvedTitle(item) ?? RenderHelpers.readableNameFromKey(key)
                out += "<li><a href=\"/docs/\(esc(SafePath.safeWebDocKey(key)))/\">\(esc(title))</a></li>"
                return
            }
            let id = item.isObject ? coerce(item.member("identifier") ?? item.member("title")) : coerce(item)
            if let key = Identifier.normalize(id) {
                let title = (item.isObject ? resolvedTitle(item) : nil) ?? RenderHelpers.readableNameFromKey(key)
                out += "<li><a href=\"/docs/\(esc(SafePath.safeWebDocKey(key)))/\">\(esc(title))</a></li>"
                return
            }
            if let refUrl = RenderHelpers.resolveReferenceUrl(id) {
                let title = (item.isObject ? resolvedTitle(item) : nil) ?? refUrl.title
                out += "<li><a href=\"\(esc(refUrl.href))\">\(esc(title))</a></li>"
                return
            }
            out += "<li>\(esc(item.isObject ? coerce(item.member("title")) : coerce(item)))</li>"
        }
        return out + "</ul>"
    }

    // MARK: - inline level

    /// renderInlineNodesToHtml: each inline node concatenated.
    func renderInlines(_ nodes: JSON?, _ depth: Int = 0) -> String {
        guard let nodes, nodes.isArray, depth <= Self.maxRenderDepth else { return "" }
        var out = ""
        nodes.forEachElement { out += renderInline($0, depth) }
        return out
    }

    func renderInline(_ node: JSON, _ depth: Int) -> String {
        guard node.isObject else { return "" }
        let type = node.member("type")

        if eq(type, "text") { return esc(coerce(node.member("text"))) }
        if eq(type, "codeVoice") { return "<code>\(esc(coerce(node.member("code"))))</code>" }
        if eq(type, "emphasis") || eq(type, "newTerm") {
            return "<em>\(renderInlines(node.member("inlineContent"), depth + 1))</em>"
        }
        if eq(type, "strong") || eq(type, "inlineHead") {
            return "<strong>\(renderInlines(node.member("inlineContent"), depth + 1))</strong>"
        }
        if eq(type, "superscript") { return "<sup>\(renderInlines(node.member("inlineContent"), depth + 1))</sup>" }
        if eq(type, "subscript") { return "<sub>\(renderInlines(node.member("inlineContent"), depth + 1))</sub>" }
        if eq(type, "strikethrough") { return "<s>\(renderInlines(node.member("inlineContent"), depth + 1))</s>" }

        if eq(type, "reference") {
            let resolvedKey = node.member("_resolvedKey")
            let key: String? =
                (resolvedKey != nil && resolvedKey!.isTruthy)
                ? coerce(resolvedKey) : Identifier.normalize(coerce(node.member("identifier")))
            let title = resolvedTitle(node) ?? (key.map(RenderHelpers.readableNameFromKey))
            if let key {
                return "<a href=\"/docs/\(esc(SafePath.safeWebDocKey(key)))/\">\(esc(title ?? ""))</a>"
            }
            if let refUrl = RenderHelpers.resolveReferenceUrl(coerce(node.member("identifier"))) {
                return "<a href=\"\(esc(refUrl.href))\">\(esc(title ?? refUrl.title))</a>"
            }
            let identifier = coerce(node.member("identifier"))
            return "<code>\(esc((title?.isEmpty == false ? title! : identifier)))</code>"
        }

        if eq(type, "link") {
            let internalKey = node.member("_resolvedKey")
            let rawHref: String =
                (internalKey != nil && internalKey!.isTruthy)
                ? "/docs/\(SafePath.safeWebDocKey(coerce(internalKey)))/"
                : ((node.member("destination").map { !$0.isNull } ?? false) ? coerce(node.member("destination")) : "#")
            let href = RenderHelpers.isSafeHref(rawHref) ? rawHref : "#"
            let titleNode = node.member("title")
            let title =
                (titleNode != nil && !titleNode!.isNull)
                ? coerce(titleNode)
                : { let r = renderInlines(node.member("inlineContent"), depth + 1); return r.isEmpty ? href : r }()
            return "<a href=\"\(esc(href))\">\(esc(title))</a>"
        }

        if eq(type, "image") {
            let altRaw = (node.member("alt").map { !$0.isNull } ?? false) ? coerce(node.member("alt")) : coerce(node.member("title"))
            let alt = esc(altRaw)
            return "<span>[\(alt.isEmpty ? "Image" : alt)]</span>"
        }

        // default: text ?? code ?? ''
        let textNode = node.member("text")
        if textNode != nil, !textNode!.isNull { return esc(coerce(textNode)) }
        return esc(coerce(node.member("code")))
    }

    // MARK: - helpers

    private func esc(_ s: String) -> String { RenderHelpers.escapeHtml(s) }

    /// `${value}` template coercion, with the `?? ''` nullish default.
    private func coerce(_ node: JSON?) -> String {
        guard let node, !node.isNull else { return "" }
        return node.string ?? node.jsString
    }

    private func eq(_ node: JSON?, _ literal: StaticString) -> Bool { node?.utf8Equals(literal) ?? false }

    private func clamp(_ x: Int, _ lo: Int, _ hi: Int) -> Int { Swift.min(Swift.max(x, lo), hi) }

    /// `_resolvedTitle` when present and non-null, else nil (so the caller's `?? …` runs).
    private func resolvedTitle(_ node: JSON) -> String? {
        guard let t = node.member("_resolvedTitle"), !t.isNull else { return nil }
        return coerce(t)
    }

    /// `(node.code ?? []).join('\n')` — coerced lines.
    private func joinLines(_ node: JSON?) -> String {
        guard let node, node.isArray else { return "" }
        var out = ""
        var first = true
        node.forEachElement { line in
            if !first { out += "\n" }
            first = false
            out += coerce(line)
        }
        return out
    }

    private func forEach(_ node: JSON?, _ body: (JSON) -> Void) {
        guard let node, node.isArray else { return }
        node.forEachElement(body)
    }

    private func elements(_ node: JSON?) -> [JSON] {
        guard let node, node.isArray else { return [] }
        var out: [JSON] = []
        node.forEachElement { out.append($0) }
        return out
    }
}

// Per-section HTML renderers + the section dispatch — native port of
// `src/content/render-html/sections.js` (+ the `renderSectionHtml` switch from
// render-html.js). Each consumes one `DocSection` and emits its `<section>`.

import ADBase
import ADJSONCore

/// The section input the HTML renderer consumes — the normalized
/// (sectionKind, heading, contentText, contentJson, sortOrder) tuple the build
/// reads from `document_sections`.
public struct DocSection: Sendable {
    public let sectionKind: String?
    public let heading: String?
    public let contentText: String?
    public let contentJson: String?
    public let sortOrder: Double

    public init(
        sectionKind: String?, heading: String?, contentText: String?, contentJson: String?,
        sortOrder: Double
    ) {
        self.sectionKind = sectionKind
        self.heading = heading
        self.contentText = contentText
        self.contentJson = contentJson
        self.sortOrder = sortOrder
    }
}

struct HtmlSections {
    let knownKeys: Set<String>?
    let highlight: CodeHighlight?

    /// Defensive cap on `markdownToHtml` input (matches `MARKDOWN_MAX_BYTES`).
    static let markdownMaxBytes = 256 * 1024

    private var nodes: HtmlNodes { HtmlNodes(highlight: highlight) }

    // MARK: - dispatch (render-html.js renderSectionHtml)

    func renderSection(_ s: DocSection) -> String {
        switch s.sectionKind {
        case "abstract": return abstract(s)
        case "declaration": return declaration(s)
        case "parameters": return parameters(s)
        case "properties": return properties(s)
        case "rest_endpoint": return restEndpoint(s)
        case "rest_parameters": return restParameters(s)
        case "rest_responses": return restResponses(s)
        case "possible_values": return possibleValues(s)
        case "mentioned_in": return mentionedIn(s)
        case "discussion": return discussion(s)
        case "topics": return linkSection("Topics", s)
        case "relationships": return linkSection("Relationships", s)
        case "see_also": return linkSection("See Also", s)
        default: return discussion(s)
        }
    }

    // MARK: - sections

    func abstract(_ s: DocSection) -> String {
        let json = safeJson(s.contentJson)
        if let json, json.isArray, !elements(json).isEmpty {
            return "<p>\(nodes.renderInlines(json))</p>"
        }
        let text = JsString.trim(s.contentText ?? "")
        if text.isEmpty { return "" }
        return text.utf16.count > Self.markdownMaxBytes
            ? "<p>\(esc(text))</p>"
            : HtmlMarkdown.markdownToHtml(text, highlight: highlight)
    }

    func declaration(_ s: DocSection) -> String {
        let blocks = elements(safeJson(s.contentJson))

        var langOrder: [String] = []
        var langSeen = Set<String>()
        for decl in blocks {
            for lang in elements(decl.member("languages")) {
                let l = coerce(lang)
                if langSeen.insert(l).inserted { langOrder.append(l) }
            }
        }
        let hasMultipleLangs = langSeen.count > 1

        var snippets: [String] = []
        for decl in blocks {
            let tokenArr = elements(decl.member("tokens"))
            if tokenArr.isEmpty { continue }
            let hasTypeLinks =
                knownKeys != nil
                && tokenArr.contains { t in
                    guard t.member("_resolvedKey")?.isTruthy ?? false else { return false }
                    let k = t.member("kind")?.string ?? ""
                    return k == "typeIdentifier" || k == "attribute"
                }
            var html: String
            if hasTypeLinks {
                html = HtmlTokens.renderDeclarationTokens(decl.member("tokens"), knownKeys!)
            } else {
                let code = JsString.trim(HtmlTokens.joinTokenTexts(decl.member("tokens")))
                if code.isEmpty { continue }
                let language = firstLanguage(decl)
                html = highlight?(code, language) ?? "<pre><code class=\"language-\(esc(language))\">\(esc(code))</code></pre>"
            }
            let declLangs = elements(decl.member("languages"))
            if hasMultipleLangs, !declLangs.isEmpty {
                snippets.append("<div class=\"decl-variant\" data-lang=\"\(esc(coerce(declLangs[0])))\">\(html)</div>")
            } else {
                snippets.append(html)
            }
        }

        if snippets.isEmpty {
            let ct = JsString.trim(s.contentText ?? "")
            if !ct.isEmpty {
                snippets.append(highlight?(ct, "swift") ?? "<pre><code class=\"language-swift\">\(esc(ct))</code></pre>")
            }
        }
        if snippets.isEmpty { return "" }

        let langAttr = hasMultipleLangs ? " data-languages=\"\(langOrder.map(esc).joined(separator: ","))\"" : ""
        return "<section id=\"declaration\"\(langAttr)><h2>Declaration</h2>\(snippets.joined())</section>"
    }

    func parameters(_ s: DocSection) -> String {
        let json = safeJson(s.contentJson)
        var items: [String] = []
        if let json, json.isArray {
            for p in elements(json) {
                items.append("<li><strong>\(esc(coerceOr(p.member("name"), "Value")))</strong>: \(nodes.renderNodes(p.member("content")))</li>")
            }
        } else {
            for line in lines(s.contentText) { items.append("<li>\(esc(line))</li>") }
        }
        if items.isEmpty { return "" }
        return "<section id=\"parameters\"><h2>Parameters</h2><ul>\(items.joined())</ul></section>"
    }

    func properties(_ s: DocSection) -> String {
        let items = elements(safeJson(s.contentJson))
        if items.isEmpty { return "" }
        let heading = s.heading ?? "Properties"
        let rows = items.map { item -> String in
            let badge = (item.member("required")?.isTruthy ?? false) ? " <span class=\"badge badge-required\">Required</span>" : ""
            return "<tr><td><code>\(esc(coerce(item.member("name"))))</code>\(badge)</td><td>\(HtmlTokens.renderTypeTokens(item.member("type"), knownKeys))</td><td>\(nodes.renderNodes(item.member("content")))</td></tr>"
        }
        return "<section id=\"\(RenderHelpers.slugify(heading))\"><h2>\(esc(heading))</h2><table class=\"properties-table\"><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>\(rows.joined())</tbody></table></section>"
    }

    func restEndpoint(_ s: DocSection) -> String {
        let tokens = elements(safeJson(s.contentJson))
        if tokens.isEmpty { return "" }
        let heading = s.heading ?? "URL"
        let spans = tokens.map { token -> String in
            let text = esc(coerce(token.member("text")))
            switch token.member("kind")?.string {
            case "method": return "<span class=\"rest-method\">\(text)</span>"
            case "baseURL": return "<span class=\"rest-base-url\">\(text)</span>"
            case "path": return "<span class=\"rest-path\">\(text)</span>"
            case "parameter": return "<span class=\"rest-param\">\(text)</span>"
            default: return text
            }
        }
        return "<section id=\"\(RenderHelpers.slugify(heading))\"><h2>\(esc(heading))</h2><pre class=\"rest-endpoint\"><code>\(spans.joined())</code></pre></section>"
    }

    func restParameters(_ s: DocSection) -> String {
        let items = elements(safeJson(s.contentJson))
        if items.isEmpty { return "" }
        let heading = s.heading ?? "Parameters"
        let rows = items.map { item -> String in
            let badge = (item.member("required")?.isTruthy ?? false)
                ? "<span class=\"badge badge-required\">Required</span>" : "<span class=\"badge badge-optional\">Optional</span>"
            return "<tr><td><code>\(esc(coerce(item.member("name"))))</code> \(badge)</td><td>\(HtmlTokens.renderTypeTokens(item.member("type"), knownKeys))</td><td>\(nodes.renderNodes(item.member("content")))</td></tr>"
        }
        return "<section id=\"\(RenderHelpers.slugify(heading))\"><h2>\(esc(heading))</h2><table class=\"params-table\"><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>\(rows.joined())</tbody></table></section>"
    }

    func restResponses(_ s: DocSection) -> String {
        let items = elements(safeJson(s.contentJson))
        if items.isEmpty { return "" }
        let heading = s.heading ?? "Response Codes"
        let rows = items.map { item -> String in
            let mime = (item.member("mimeType")?.isTruthy ?? false)
                ? "<div class=\"rest-mime\">Content-Type: \(esc(coerce(item.member("mimeType"))))</div>" : ""
            return "<tr><td><strong>\(esc(coerce(item.member("status"))))</strong></td><td>\(esc(coerce(item.member("reason"))))\(mime)</td><td>\(HtmlTokens.renderTypeTokens(item.member("type"), knownKeys))</td><td>\(nodes.renderNodes(item.member("content")))</td></tr>"
        }
        return "<section id=\"\(RenderHelpers.slugify(heading))\"><h2>\(esc(heading))</h2><table class=\"responses-table\"><thead><tr><th>Status</th><th>Reason</th><th>Type</th><th>Description</th></tr></thead><tbody>\(rows.joined())</tbody></table></section>"
    }

    func possibleValues(_ s: DocSection) -> String {
        let values = elements(safeJson(s.contentJson))
        if values.isEmpty { return "" }
        let heading = s.heading ?? "Possible Values"
        let items = values.map { "<dt><code>\(esc(coerce($0.member("name"))))</code></dt><dd>\(nodes.renderNodes($0.member("content")))</dd>" }
        return "<section id=\"\(RenderHelpers.slugify(heading))\"><h2>\(esc(heading))</h2><dl class=\"possible-values\">\(items.joined())</dl></section>"
    }

    func mentionedIn(_ s: DocSection) -> String {
        let items = elements(safeJson(s.contentJson))
        if items.isEmpty { return "" }
        let heading = s.heading ?? "Mentioned in"
        let list = items.map { item -> String in
            if let key = item.member("key"), key.isTruthy {
                return "<li><a href=\"/docs/\(esc(SafePath.safeWebDocKey(coerce(key))))/\">\(esc(coerceOr(item.member("title"), coerce(key))))</a></li>"
            }
            return "<li>\(esc(coerceOr(item.member("title"), coerce(item.member("identifier")))))</li>"
        }
        return "<section id=\"\(RenderHelpers.slugify(heading))\"><h2>\(esc(heading))</h2><ul>\(list.joined())</ul></section>"
    }

    func discussion(_ s: DocSection) -> String {
        let heading = s.heading ?? "Overview"
        let sectionId = RenderHelpers.slugify(heading)
        let json = safeJson(s.contentJson)
        if let json, json.isArray, !elements(json).isEmpty {
            let filtered = skipDuplicateHeading(elements(json), heading)
            let body = nodes.renderNodes(filtered)
            if JsString.trim(body).isEmpty { return "" }
            return "<section id=\"\(sectionId)\"><h2>\(esc(heading))</h2>\(body)</section>"
        }
        let text = JsString.trim(s.contentText ?? "")
        if text.isEmpty { return "" }
        let body = text.utf16.count > Self.markdownMaxBytes
            ? "<pre class=\"markdown-fallback\"><code>\(esc(text))</code></pre>"
            : HtmlMarkdown.markdownToHtml(text, highlight: highlight)
        return "<section id=\"\(sectionId)\"><h2>\(esc(heading))</h2>\(body)</section>"
    }

    func linkSection(_ title: String, _ s: DocSection) -> String {
        let sectionId = RenderHelpers.slugify(title)
        let groups = elements(safeJson(s.contentJson))
        var body = ""
        if !groups.isEmpty {
            for group in groups {
                if let gt = group.member("title"), gt.isTruthy {
                    body += "<h3>\(esc(coerce(gt)))</h3>"
                }
                var items = ""
                for item in elements(group.member("items")) {
                    let filterAttr = (item.member("_resolvedRoleHeading")?.isTruthy ?? false)
                        ? " data-filter-kind=\"\(esc(coerce(item.member("_resolvedRoleHeading"))))\"" : ""
                    if let key = item.member("key"), key.isTruthy {
                        items += "<li\(filterAttr)><a href=\"/docs/\(esc(SafePath.safeWebDocKey(coerce(key))))/\"><code>\(esc(coerceOr(item.member("title"), coerce(key))))</code></a></li>"
                    } else {
                        items += "<li>\(esc(coerceOr(item.member("title"), coerce(item.member("identifier")))))</li>"
                    }
                }
                if !items.isEmpty { body += "<ul>\(items)</ul>" }
            }
        } else {
            let lns = lines(s.contentText)
            if !lns.isEmpty {
                body += "<ul>\(lns.map { "<li>\(esc($0))</li>" }.joined())</ul>"
            }
        }
        if body.isEmpty { return "" }
        return "<section id=\"\(sectionId)\"><h2>\(esc(title))</h2>\(body)</section>"
    }

    // MARK: - helpers

    /// `skipDuplicateHeading`: drop the first node if it is a heading whose text
    /// matches the section heading (case-insensitively).
    func skipDuplicateHeading(_ nodes: [JSON], _ heading: String) -> [JSON] {
        guard let first = nodes.first, first.member("type")?.utf8Equals("heading") ?? false else {
            return nodes
        }
        let headingText = coerce(first.member("text"))
        if JsString.lowercase(headingText) == JsString.lowercase(heading) {
            return Array(nodes.dropFirst())
        }
        return nodes
    }

    private func firstLanguage(_ decl: JSON) -> String {
        let langs = elements(decl.member("languages"))
        return langs.isEmpty ? "swift" : coerce(langs[0])
    }

    /// `text?.trim().split('\n').filter(Boolean)`.
    private func lines(_ text: String?) -> [String] {
        let t = JsString.trim(text ?? "")
        if t.isEmpty { return [] }
        return t.split(separator: "\n").map(String.init)
    }

    private func esc(_ s: String) -> String { RenderHelpers.escapeHtml(s) }

    private func coerce(_ node: JSON?) -> String {
        guard let node, !node.isNull else { return "" }
        return node.string ?? node.jsString
    }

    /// `node ?? fallback` with the nullish (`?? ''`) default semantics.
    private func coerceOr(_ node: JSON?, _ fallback: String) -> String {
        guard let node, !node.isNull else { return fallback }
        return node.string ?? node.jsString
    }

    private func elements(_ node: JSON?) -> [JSON] {
        guard let node, node.isArray else { return [] }
        var out: [JSON] = []
        node.forEachElement { out.append($0) }
        return out
    }
}

/// `safeJson` — parse a stored JSON string to a value, nil on empty/error.
func safeJson(_ s: String?) -> JSON? {
    guard let s, !s.isEmpty else { return nil }
    return try? ADJSON.parse(s, options: .init(maxDepth: 512)).root
}

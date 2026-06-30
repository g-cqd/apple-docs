// Top-level DocC → HTML dispatch — native port of `src/content/render-html.js`
// `renderHtml`. Sorts the sections, emits `<h1>` + each section's HTML, joins +
// trims. The article-body fragment the web build's DocPage wraps in page chrome.

public enum DocContentRenderer {
    /// renderHtml(document, sections, opts). `title` is the document title (the
    /// only `document` field the JS dispatch reads); `knownKeys` gates type-link
    /// emission; `highlight` is the code seam (nil → `<pre><code>` fallback).
    public static func render(
        title: String?, sections: [DocSection], knownKeys: Set<String>? = nil,
        highlight: CodeHighlight? = nil
    ) -> String {
        // JS `Array.sort` is stable; break ties on the original index to match.
        let ordered = sections.enumerated().sorted { a, b in
            a.element.sortOrder == b.element.sortOrder
                ? a.offset < b.offset : a.element.sortOrder < b.element.sortOrder
        }.map(\.element)

        let renderer = HtmlSections(knownKeys: knownKeys, highlight: highlight)
        var parts: [String] = []
        if let title, !title.isEmpty {
            parts.append("<h1>\(RenderHelpers.escapeHtml(title))</h1>")
        }
        for section in ordered {
            let rendered = renderer.renderSection(section)
            if !rendered.isEmpty { parts.append(rendered) }
        }
        return JsString.trim(parts.joined(separator: "\n"))
    }
}

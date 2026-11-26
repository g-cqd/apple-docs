public import AppleDocsOutput

/// Escaped, zero-dependency server-side HTML renderer for `apple-docs web serve` and static site export.
///
/// Escapes every dynamic text interpolation against XSS (`&`, `<`, `>`, `"`, `'`) before emission.
public enum WebHTMLRenderer: Sendable {
    /// Escapes untrusted text for safe insertion into HTML element content or double-quoted attributes.
    public static func escapeHTML(_ raw: String) -> String {
        var out = ""
        out.reserveCapacity(raw.utf8.count)
        for scalar in raw.unicodeScalars {
            switch scalar {
                case "&": out.append("&amp;")
                case "<": out.append("&lt;")
                case ">": out.append("&gt;")
                case "\"": out.append("&quot;")
                case "'": out.append("&#39;")
                default: out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    /// Renders a clean semantic HTML5 document page for a ``PublicDocumentDetail``.
    public static func renderDocumentPage(_ detail: PublicDocumentDetail) -> String {
        let title = escapeHTML(detail.document.title)
        let framework = escapeHTML(detail.document.framework)
        var bodyParts: [String] = ["<h1>\(title)</h1>", "<p class=\"meta\">\(framework)</p>"]
        if let abstract = detail.document.abstract, !abstract.isEmpty {
            bodyParts.append("<p class=\"abstract\">\(escapeHTML(abstract))</p>")
        }
        if let declaration = detail.document.declaration, !declaration.isEmpty {
            bodyParts.append("<pre><code>\(escapeHTML(declaration))</code></pre>")
        }
        for section in detail.sections {
            if let heading = section.heading, !heading.isEmpty {
                bodyParts.append("<h2>\(escapeHTML(heading))</h2>")
            }
            bodyParts.append("<div class=\"section\"><p>\(escapeHTML(section.content))</p></div>")
        }
        return wrapPage(title: "\(detail.document.title) — apple-docs", body: bodyParts.joined(separator: "\n"))
    }

    /// Renders the HTML landing index listing all available frameworks and collections.
    public static func renderIndexPage(frameworks: [PublicFrameworkSummary]) -> String {
        let items = frameworks.map { item in
            let slug = escapeHTML(item.slug)
            let name = escapeHTML(item.displayName)
            return "<li><a href=\"/doc/\(slug)\">\(name)</a> <span>(\(item.pageCount))</span></li>"
        }
        let body = "<h1>Apple Documentation</h1><ul>\(items.joined(separator: "\n"))</ul>"
        return wrapPage(title: "apple-docs", body: body)
    }

    private static func wrapPage(title: String, body: String) -> String {
        """
        <!doctype html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>\(escapeHTML(title))</title>
        </head>
        <body><main>\(body)</main></body>
        </html>
        """
    }
}

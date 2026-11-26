import AemiKernel

/// Escaped, zero-dependency server-side HTML renderer for `apple-docs web serve` and static site export.
///
/// Every dynamic text interpolation is escaped (`&`, `<`, `>`, `"`, `'`) before emission, and pages carry
/// no inline script or style: the shared layout links `/assets/style.css` and `/assets/app.js`, so the
/// strict `default-src 'self'` Content-Security-Policy holds.
public enum WebHTMLRenderer: Sendable {
    /// Escapes untrusted text for safe insertion into HTML/XML element content or double-quoted attributes
    /// via `aemi`'s SIMD-backed `XMLEscape` (`AemiKernels.firstIndexOfAny`).
    public static func escapeHTML(_ raw: String) -> String {
        XMLEscape.escaped(raw)
    }

    /// The styled "Page not found" page served with `404`.
    public static func renderNotFoundPage(path: String) -> String {
        page(
            title: "Page not found — apple-docs",
            body: """
                <section class="not-found">
                <h1>Page not found</h1>
                <p class="muted">Nothing is published at <code>\(escapeHTML(path))</code>.</p>
                <p><a href="/">Browse all frameworks</a> or <a href="/search">search the documentation</a>.</p>
                </section>
                """
        )
    }

    /// Renders stored section Markdown (the converters' subset) to escaped HTML, as document pages do.
    public static func renderMarkdownFragment(_ markdown: String) -> String {
        WebMarkdownBlockRenderer.render(markdown)
    }

    /// The shared HTML5 layout: header (brand, navigation, search, theme toggle), `<main>`, and footer.
    static func page(title: String, description: String? = nil, body: String) -> String {
        let meta = description.map { "\n<meta name=\"description\" content=\"\(escapeHTML($0))\">" } ?? ""
        return """
            <!doctype html>
            <html lang="en" data-base="">
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <title>\(escapeHTML(title))</title>\(meta)
            <link rel="stylesheet" href="/assets/style.css">
            <script src="/assets/app.js"></script>
            </head>
            <body>
            <header class="site-header">
            <a class="brand" href="/">apple-docs</a>
            <nav class="site-nav" aria-label="Primary">\
            <a href="/">Home</a><a href="/search">Search</a><a href="/symbols">Symbols</a><a href="/fonts">Fonts</a>\
            </nav>
            <form class="site-search" action="/search" method="get" role="search">\
            <input type="search" name="q" placeholder="Search documentation (/)" aria-label="Search documentation">\
            </form>
            <button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle color theme">◐</button>
            </header>
            <main>
            \(body)
            </main>
            <footer>Apple documentation mirrored locally by apple-docs. Content © Apple Inc.</footer>
            </body>
            </html>
            """
    }

    /// A breadcrumb trail; crumbs without an `href` (the current page) render as plain text.
    static func breadcrumbs(_ crumbs: [(label: String, href: String?)]) -> String {
        let items = crumbs.map { crumb in
            if let href = crumb.href {
                return "<li><a href=\"\(escapeHTML(href))\">\(escapeHTML(crumb.label))</a></li>"
            }
            return "<li aria-current=\"page\">\(escapeHTML(crumb.label))</li>"
        }
        return "<nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\"><ol>\(items.joined())</ol></nav>"
    }

    /// A `<ul class="link-list">` of `/doc/<path>` links.
    static func linkList(_ links: [(path: String, title: String)]) -> String {
        let items = links.map { link in
            "<li><a href=\"\(escapeHTML(WebDocPath.href(link.path)))\">\(escapeHTML(link.title))</a></li>"
        }
        return "<ul class=\"link-list\">\(items.joined())</ul>"
    }
}

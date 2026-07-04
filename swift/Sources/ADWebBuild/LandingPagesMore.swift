// The remaining standalone landing pages — ports of `src/web/templates/
// symbols.js`, `fonts.js`, and `index-page.js`. Like the other landing pages
// they're byte-exact against the JS `html` DSL output. The index page reuses
// `DocSidebar.renderTocHtml` + `RenderHelpers.slugify` so its anchors match.

import ADContent
public import ADJSONCore

/// One framework/extras entry for the home index listing (`renderIndexPage`'s
/// `frameworks`). Mirrors the JS `{ kind, slug, name, display_name, doc_count,
/// href }` shape; `slug` is the only required field.
public struct IndexFramework: Sendable {
    public var kind: String?
    public var slug: String
    public var name: String?
    public var displayName: String?
    public var docCount: Int?
    public var href: String?

    public init(
        kind: String? = nil, slug: String, name: String? = nil, displayName: String? = nil,
        docCount: Int? = nil, href: String? = nil
    ) {
        self.kind = kind
        self.slug = slug
        self.name = name
        self.displayName = displayName
        self.docCount = docCount
        self.href = href
    }
}

extension LandingPages {
    // MARK: - Symbols

    /// renderSymbolsPage(siteConfig, { totals }) — the SF Symbols browser shell.
    /// `totals` rows ({scope, count}) feed the lede counts + CollectionPage
    /// `numberOfItems`; the grid/inspector are client-rendered by symbols-page.js.
    public static func renderSymbolsPage(
        _ config: SiteConfig, totals: [(scope: String, count: Int)] = []
    ) -> String {
        let pageTitle = "Symbols — \(config.siteName)"
        let canonical = "\(config.baseUrl)/symbols"
        let description =
            "Browse, search, and download SF Symbols. Customize size and colors before exporting SVG or PNG."
        let totalCount = totals.reduce(0) { $0 + $1.count }
        let publicCount = totals.first { $0.scope == "public" }?.count ?? 0
        let privateCount = totals.first { $0.scope == "private" }?.count ?? 0

        let jsonLd = JsonLd.object([
            ("@context", .string("https://schema.org")),
            ("@type", .string("CollectionPage")),
            ("name", .string(pageTitle)),
            ("description", .string(description)),
            ("inLanguage", .string("en")),
            ("isAccessibleForFree", .bool(true)),
            ("url", .string(canonical)),
            (
                "isPartOf",
                .object([
                    ("@type", .string("WebSite")), ("name", .string(config.siteName)),
                    ("url", .string("\(config.baseUrl)/"))
                ])
            ),
            (
                "about",
                .object([
                    ("@type", .string("Thing")), ("name", .string("SF Symbols")),
                    (
                        "description",
                        .string("Apple's icon library shipped with iOS, macOS, watchOS, tvOS, and visionOS.")
                    )
                ])
            ),
            ("numberOfItems", .int(totalCount))
        ])
        let head = PageShell.buildHead(
            config: config, title: pageTitle, description: description,
            canonical: canonical, ogType: "website", jsonLd: jsonLd.serialized())
        let lede =
            "<span id=\"symbols-count\">\(groupThousands(totalCount))</span> symbols indexed (\(groupThousands(publicCount)) public, \(groupThousands(privateCount)) private). Tap a tile to open it; customize size, weight, and color in the toolbar."
        let script = "<script src=\"\(WebHtml.escape(WebHtml.assetUrl(config, "symbols-page.js")))\" defer></script>"
        return
            "<!DOCTYPE html>\n<html lang=\"en\" data-theme=\"auto\">\n\(head)\n<body>\n<a href=\"#main-content\" class=\"skip-link\">Skip to main content</a>\n\(PageShell.buildHeader(config))\n<main id=\"main-content\" class=\"main-content symbols-page\">\n  <header class=\"symbols-page__header\">\n    <h1>SF Symbols</h1>\n    <p class=\"symbols-page__lede\">\(lede)</p>\n  </header>\n\n  <div class=\"symbols-toolbar\" role=\"search\" aria-label=\"Symbol toolbar\">\n    <div class=\"symbols-toolbar__row symbols-toolbar__row--search\">\n      <input id=\"symbols-q\" class=\"symbols-search\" type=\"search\" placeholder=\"Search symbols (⌘K)…\" aria-label=\"Search symbols\" autocomplete=\"off\" enterkeyhint=\"search\">\n      <select id=\"symbols-scope\" class=\"symbols-scope\" aria-label=\"Scope\">\n        <option value=\"\">All scopes</option>\n        <option value=\"public\">Public</option>\n        <option value=\"private\">Private</option>\n      </select>\n      <select id=\"symbols-category-mobile\" class=\"symbols-category-mobile\" aria-label=\"Category\">\n        <option value=\"\">All categories</option>\n      </select>\n    </div>\n    <div class=\"symbols-toolbar__row symbols-toolbar__row--customize\">\n      <label class=\"symbols-control symbols-control--color\">\n        <span class=\"symbols-control__legend\">Color</span>\n        <span class=\"symbols-color\">\n          <input id=\"symbols-color\" type=\"color\" value=\"#000000\" aria-label=\"Symbol color\">\n          <input id=\"symbols-color-hex\" type=\"text\" value=\"#000000\" pattern=\"^#[0-9a-fA-F]{6}$\" maxlength=\"7\" aria-label=\"Symbol color hex\">\n        </span>\n      </label>\n      <label class=\"symbols-control symbols-control--size\">\n        <span class=\"symbols-control__legend\">Tile size <span id=\"symbols-size-value\">48</span>px</span>\n        <input id=\"symbols-size\" type=\"range\" min=\"24\" max=\"120\" value=\"48\" aria-label=\"Tile size in pixels\">\n      </label>\n      <span id=\"symbols-status\" class=\"symbols-status\" role=\"status\" aria-live=\"polite\"></span>\n    </div>\n  </div>\n\n  <div class=\"symbols-layout\" id=\"symbols-layout\">\n    <aside class=\"symbols-categories\" id=\"symbols-categories\" aria-label=\"Categories\">\n      <h2 class=\"symbols-categories__title\">Categories</h2>\n      <ul class=\"symbols-categories__list\" id=\"symbols-categories-list\" role=\"listbox\" aria-label=\"Filter by category\"></ul>\n    </aside>\n\n    <div id=\"symbols-scroller\" class=\"symbols-scroller\" tabindex=\"0\" aria-label=\"Symbol grid\">\n      <p id=\"symbols-typing-hint\" class=\"symbols-typing-hint\" hidden></p>\n      <div id=\"symbols-grid\" class=\"symbols-grid\" role=\"grid\"></div>\n    </div>\n\n    <aside id=\"symbols-detail\" class=\"symbols-detail\" hidden aria-label=\"Symbol detail\">\n      <button id=\"symbols-detail-close\" class=\"symbols-detail__close\" type=\"button\" aria-label=\"Close detail\">&times;</button>\n      <div class=\"symbols-detail__preview-wrap\">\n        <span id=\"symbols-detail-preview\" class=\"symbols-detail__preview\" role=\"img\" aria-label=\"\"></span>\n      </div>\n      <h2 id=\"symbols-detail-name\" class=\"symbols-detail__name\"></h2>\n      <p id=\"symbols-detail-scope\" class=\"symbols-detail__scope\"></p>\n\n      <section class=\"symbols-detail__axes\" aria-label=\"Variable axes\">\n        <fieldset class=\"symbols-control symbols-control--weight\">\n          <legend class=\"symbols-control__legend\">Weight</legend>\n          <div class=\"symbols-control__pills\" role=\"radiogroup\" aria-label=\"Weight\" data-axis=\"weight\">\n            <button type=\"button\" class=\"symbols-pill\" role=\"radio\" data-weight=\"ultralight\" aria-checked=\"false\" title=\"Ultralight\">UL</button>\n            <button type=\"button\" class=\"symbols-pill\" role=\"radio\" data-weight=\"thin\" aria-checked=\"false\" title=\"Thin\">T</button>\n            <button type=\"button\" class=\"symbols-pill\" role=\"radio\" data-weight=\"light\" aria-checked=\"false\" title=\"Light\">L</button>\n            <button type=\"button\" class=\"symbols-pill\" role=\"radio\" data-weight=\"regular\" aria-checked=\"true\" title=\"Regular\">R</button>\n            <button type=\"button\" class=\"symbols-pill\" role=\"radio\" data-weight=\"medium\" aria-checked=\"false\" title=\"Medium\">M</button>\n            <button type=\"button\" class=\"symbols-pill\" role=\"radio\" data-weight=\"semibold\" aria-checked=\"false\" title=\"Semibold\">SB</button>\n            <button type=\"button\" class=\"symbols-pill\" role=\"radio\" data-weight=\"bold\" aria-checked=\"false\" title=\"Bold\">B</button>\n            <button type=\"button\" class=\"symbols-pill\" role=\"radio\" data-weight=\"heavy\" aria-checked=\"false\" title=\"Heavy\">H</button>\n            <button type=\"button\" class=\"symbols-pill\" role=\"radio\" data-weight=\"black\" aria-checked=\"false\" title=\"Black\">Bk</button>\n          </div>\n        </fieldset>\n        <fieldset class=\"symbols-control symbols-control--scale\">\n          <legend class=\"symbols-control__legend\">Scale</legend>\n          <div class=\"symbols-control__pills\" role=\"radiogroup\" aria-label=\"Scale\" data-axis=\"scale\">\n            <button type=\"button\" class=\"symbols-pill\" role=\"radio\" data-scale=\"small\" aria-checked=\"false\" title=\"Small\">S</button>\n            <button type=\"button\" class=\"symbols-pill\" role=\"radio\" data-scale=\"medium\" aria-checked=\"true\" title=\"Medium\">M</button>\n            <button type=\"button\" class=\"symbols-pill\" role=\"radio\" data-scale=\"large\" aria-checked=\"false\" title=\"Large\">L</button>\n          </div>\n        </fieldset>\n      </section>\n\n      <section class=\"symbols-detail__downloads\" aria-label=\"Downloads\">\n        <button id=\"symbols-detail-copy-svg\" class=\"symbols-detail__download symbols-detail__download--primary\" type=\"button\">Copy SVG</button>\n        <a id=\"symbols-detail-download-svg\" class=\"symbols-detail__download\" href=\"#\" download>Download SVG</a>\n        <a id=\"symbols-detail-download-png\" class=\"symbols-detail__download\" href=\"#\" download>Download PNG</a>\n      </section>\n\n      <section class=\"symbols-detail__metadata\" aria-label=\"Metadata\">\n        <dl id=\"symbols-detail-meta\"></dl>\n      </section>\n    </aside>\n  </div>\n\n  <div class=\"symbols-mobile-bar\" id=\"symbols-mobile-bar\" hidden>\n    <button id=\"symbols-mobile-back\" type=\"button\" class=\"symbols-mobile-bar__back\" aria-label=\"Back to grid\">&larr;</button>\n    <span id=\"symbols-mobile-name\" class=\"symbols-mobile-bar__name\"></span>\n    <button id=\"symbols-mobile-copy\" type=\"button\" class=\"symbols-mobile-bar__cta\">Copy SVG</button>\n  </div>\n</main>\n\(PageShell.buildFooter(config))\n\(script)\n</body>\n</html>"
    }

    // MARK: - Fonts

    /// renderFontsPage(siteConfig, { families }) — the typography browser. The
    /// `families` JSON (array of {id, display_name, files:[{is_variable, source}]})
    /// drives both the server-rendered family cards and the embedded
    /// `<script id="fonts-data">` payload (consumed by fonts-page.js).
    public static func renderFontsPage(_ config: SiteConfig, families: JSON? = nil) -> String {
        let pageTitle = "Fonts — \(config.siteName)"
        let canonical = "\(config.baseUrl)/fonts"
        let description = "Browse, preview, and download Apple typography (SF Pro, SF Mono, New York, …)."
        let baseUrl = config.baseUrl
        let familyList = elements(families)
        let familiesJson = familiesJsonString(families)

        let jsonLd = JsonLd.object([
            ("@context", .string("https://schema.org")),
            ("@type", .string("CollectionPage")),
            ("name", .string(pageTitle)),
            ("description", .string(description)),
            ("inLanguage", .string("en")),
            ("isAccessibleForFree", .bool(true)),
            ("url", .string(canonical)),
            (
                "isPartOf",
                .object([
                    ("@type", .string("WebSite")), ("name", .string(config.siteName)),
                    ("url", .string("\(config.baseUrl)/"))
                ])
            ),
            (
                "about",
                .object([
                    ("@type", .string("Thing")), ("name", .string("Apple Typography")),
                    (
                        "description",
                        .string(
                            "San Francisco type-family variants distributed by Apple: SF Pro, SF Mono, SF Compact, New York."
                        )
                    )
                ])
            ),
            ("numberOfItems", .int(familyList.count))
        ])
        let head = PageShell.buildHead(
            config: config, title: pageTitle, description: description, canonical: canonical,
            ogType: "website", jsonLd: jsonLd.serialized(),
            headExtra: "<link rel=\"stylesheet\" href=\"\(WebHtml.escape(baseUrl))/api/fonts/faces.css\">")

        let familyMarkup = familyList.map { renderFontFamily($0, baseUrl: baseUrl) }.joined()
        let script = "<script src=\"\(WebHtml.escape(WebHtml.assetUrl(config, "fonts-page.js")))\" defer></script>"
        return
            "<!DOCTYPE html>\n<html lang=\"en\" data-theme=\"auto\">\n\(head)\n<body>\n<a href=\"#main-content\" class=\"skip-link\">Skip to main content</a>\n\(PageShell.buildHeader(config))\n<main id=\"main-content\" class=\"main-content fonts-page\">\n  <header class=\"fonts-page__header\">\n    <h1>Apple Fonts</h1>\n    <p class=\"fonts-page__lede\">Live preview every family with its real files. Set the sample, size, weight, and italic once — every preview on the page follows. Grab a ZIP per family: all weights, just variable, or just statics.</p>\n  </header>\n\n  <section class=\"fonts-tester\" aria-label=\"Font preview controls\">\n    <label class=\"fonts-tester__field\">\n      <span class=\"fonts-tester__label\">Sample text</span>\n      <input id=\"fonts-sample\" class=\"fonts-tester__sample\" type=\"text\" aria-label=\"Sample text\" value=\"Reading Apple docs in good type.\" enterkeyhint=\"done\">\n    </label>\n    <div class=\"fonts-tester__row\">\n      <label class=\"fonts-tester__field fonts-tester__field--size\">\n        <span class=\"fonts-tester__label\">Size <span id=\"fonts-size-value\">48</span>px</span>\n        <input id=\"fonts-size\" type=\"range\" min=\"12\" max=\"144\" value=\"48\" aria-label=\"Preview size in pixels\">\n      </label>\n      <label class=\"fonts-tester__field fonts-tester__field--weight\">\n        <span class=\"fonts-tester__label\">Weight <span id=\"fonts-weight-value\">400</span></span>\n        <input id=\"fonts-weight\" type=\"range\" min=\"100\" max=\"900\" step=\"100\" value=\"400\" aria-label=\"Font weight, 100 to 900\">\n      </label>\n      <label class=\"fonts-tester__field fonts-tester__field--italic\">\n        <span class=\"fonts-tester__label\">Italic</span>\n        <span class=\"fonts-tester__switch\">\n          <input id=\"fonts-italic\" type=\"checkbox\" role=\"switch\" aria-label=\"Italic\">\n          <span class=\"fonts-tester__switch-track\" aria-hidden=\"true\"></span>\n        </span>\n      </label>\n      <label class=\"fonts-tester__field fonts-tester__field--style\">\n        <span class=\"fonts-tester__label\">Style</span>\n        <select id=\"fonts-style\" class=\"fonts-tester__style\" aria-label=\"Optical-size variant\">\n          <option value=\"auto\" selected>Auto (best fit)</option>\n          <option value=\"Display\">Display</option>\n          <option value=\"Text\">Text</option>\n          <option value=\"Rounded\">Rounded</option>\n          <option value=\"Small\">Small</option>\n          <option value=\"Medium\">Medium</option>\n          <option value=\"Large\">Large</option>\n          <option value=\"ExtraLarge\">Extra Large</option>\n        </select>\n      </label>\n    </div>\n  </section>\n\n  <section class=\"font-family-grid\" id=\"font-family-grid\">\(familyMarkup)</section>\n\n  <div class=\"fonts-bottom-bar\" id=\"fonts-bottom-bar\">\n    <a class=\"fonts-bottom-bar__cta\" href=\"#\" id=\"fonts-bottom-bar-cta\" download hidden>Download family</a>\n    <a class=\"fonts-bottom-bar__cta fonts-bottom-bar__cta--all\" href=\"#\" id=\"fonts-bottom-bar-all\">Jump to family list</a>\n  </div>\n\n  <script id=\"fonts-data\" type=\"application/json\">\(familiesJson)</script>\n</main>\n\(PageShell.buildFooter(config))\n\(script)\n</body>\n</html>"
    }

    /// One `<article class="font-family">` card. Mirrors the per-family `html`
    /// block in fonts.js (file/variable/remote/system counts → meta line, the
    /// three subset download links).
    private static func renderFontFamily(_ family: JSON, baseUrl: String) -> String {
        let id = coerce(family.member("id"))
        let displayName = coerce(family.member("display_name"))
        let files = elements(family.member("files"))
        let filesCount = files.count
        let variableCount = files.filter { ($0.member("is_variable")?.isTruthy) ?? false }.count
        let remoteCount = files.filter { coerce($0.member("source")) == "remote" }.count
        let systemCount = files.filter { coerce($0.member("source")) == "system" }.count

        var metaParts: [String] = ["\(filesCount) file\(filesCount == 1 ? "" : "s")"]
        if variableCount > 0 { metaParts.append("\(variableCount) variable") }
        if remoteCount > 0 { metaParts.append("\(remoteCount) remote") }
        if systemCount > 0 { metaParts.append("\(systemCount) system") }
        let meta = metaParts.joined(separator: " · ")

        let encodedId = WebHtml.encodeURIComponent(id)
        func familyZip(_ subset: String) -> String {
            let query = (!subset.isEmpty && subset != "all") ? "?subset=\(WebHtml.encodeURIComponent(subset))" : ""
            return "\(baseUrl)/api/fonts/family/\(encodedId).zip\(query)"
        }
        var buttons =
            "<a class=\"font-family__download\" href=\"\(WebHtml.escape(familyZip("all")))\" download>Download all</a>"
        if variableCount > 0 {
            buttons +=
                "<a class=\"font-family__download font-family__download--alt\" href=\"\(WebHtml.escape(familyZip("variable")))\" download>Variable only</a>"
        }
        if filesCount - variableCount > 0 {
            buttons +=
                "<a class=\"font-family__download font-family__download--alt\" href=\"\(WebHtml.escape(familyZip("static")))\" download>Static only</a>"
        }

        return
            "\n    <article class=\"font-family\" data-family-id=\"\(WebHtml.escape(id))\">\n      <header class=\"font-family__header\">\n        <div class=\"font-family__title-row\">\n          <h2 class=\"font-family__title\">\(WebHtml.escape(displayName))</h2>\n        </div>\n        <p class=\"font-family__meta\">\(WebHtml.escape(meta))</p>\n        <div class=\"font-family__downloads\">\(buttons)</div>\n      </header>\n      <div class=\"font-family__variants\" data-variants></div>\n      <div class=\"font-family__preview\" data-preview></div>\n    </article>"
    }

    // MARK: - Index (home)

    /// renderIndexPage(frameworks, siteConfig, { extras }) — the home page: the
    /// framework roster grouped by kind, with a TOC sidebar when ≥2 kinds. The
    /// `extras` map appends synthetic entries (e.g. /fonts, /symbols) per kind.
    public static func renderIndexPage(
        _ frameworks: [IndexFramework], _ config: SiteConfig,
        extras: [(kind: String, items: [IndexFramework])] = []
    ) -> String {
        let pageTitle = config.siteName
        let description = "Apple developer documentation, indexed locally."
        let canonical = "\(config.baseUrl)/"

        // Group by kind, preserving insertion order; then the extras hook.
        var order: [String] = []
        var groups: [String: [IndexFramework]] = [:]
        func push(_ kind: String, _ fw: IndexFramework) {
            if groups[kind] == nil {
                order.append(kind)
                groups[kind] = []
            }
            groups[kind]!.append(fw)
        }
        for fw in frameworks { push(fw.kind ?? "other", fw) }
        for (kind, items) in extras { for fw in items { push(kind, fw) } }

        var sections: [String] = []
        for kind in order {
            let items = groups[kind] ?? []
            let listItems = items.map { fw -> String in
                let href = fw.href ?? "\(config.baseUrl)/docs/\(fw.slug)/"
                let name = fw.displayName ?? fw.name ?? fw.slug
                let countBadge = fw.docCount.map { " <span class=\"badge badge-count\">\($0)</span>" } ?? ""
                return
                    "<li data-filter-kind=\"\(WebHtml.escape(kind))\"><a href=\"\(WebHtml.escape(href))\">\(WebHtml.escape(name))</a>\(countBadge)</li>"
            }
            let kindId = RenderHelpers.slugify(kind)
            sections.append(
                "<section id=\"\(WebHtml.escape(kindId))\" class=\"framework-group\" data-filter-kind=\"\(WebHtml.escape(kind))\">\n    <h2 class=\"framework-kind\">\(WebHtml.escape(kind))</h2>\n    <ul class=\"framework-list\">\n      \(listItems.joined(separator: "\n      "))\n    </ul>\n  </section>"
            )
        }
        let mainContent =
            sections.isEmpty ? "<p>No frameworks indexed yet.</p>" : sections.joined(separator: "\n  ")

        let tocItems = order.map { DocSidebar.TocItem(id: RenderHelpers.slugify($0), label: $0) }
        let hasSidebar = tocItems.count >= 2
        let sidebar =
            hasSidebar
            ? "<aside class=\"doc-sidebar\"><div class=\"sidebar-block\">\(DocSidebar.renderTocHtml(tocItems, mobile: false))</div></aside>"
            : ""
        let mobileToc = hasSidebar ? DocSidebar.renderTocHtml(tocItems, mobile: true) : ""

        let jsonLd = JsonLd.object([
            ("@context", .string("https://schema.org")),
            ("@type", .string("WebSite")),
            ("name", .string(config.siteName)),
            ("url", .string(canonical)),
            ("description", .string(description)),
            (
                "potentialAction",
                .object([
                    ("@type", .string("SearchAction")),
                    ("target", .string("\(config.baseUrl)/search?q={query}")),
                    ("query-input", .string("required name=query"))
                ])
            )
        ])
        let head = PageShell.buildHead(
            config: config, title: pageTitle, description: description,
            canonical: canonical, ogType: "website", jsonLd: jsonLd.serialized())
        let sidebarClass = hasSidebar ? " has-sidebar" : ""
        return
            "<!DOCTYPE html>\n<html lang=\"en\" data-theme=\"auto\">\n\(head)\n<body>\n<a href=\"#main-content\" class=\"skip-link\">Skip to main content</a>\n\(PageShell.buildHeader(config))\n<main id=\"main-content\" class=\"main-content\(sidebarClass) listing\">\n  <h1>\(WebHtml.escape(config.siteName))</h1>\n  \(mobileToc)\n  <article class=\"doc-article\">\n  \(mainContent)\n  </article>\n  \(sidebar)\n</main>\n\(PageShell.buildFooter(config))\n\(PageShell.buildScripts(config, ["core", "listing"]))\n</body>\n</html>"
    }

    // MARK: - helpers

    /// `Number.prototype.toLocaleString('en-US')` for a non-negative count:
    /// digit grouping with `,` every three places.
    static func groupThousands(_ n: Int) -> String {
        let negative = n < 0
        var x = negative ? -n : n
        if x == 0 { return "0" }
        var digits: [Character] = []
        var count = 0
        while x > 0 {
            if count > 0, count % 3 == 0 { digits.append(",") }
            digits.append(Character(String(x % 10)))
            x /= 10
            count += 1
        }
        if negative { digits.append("-") }
        return String(digits.reversed())
    }

    /// `JSON.stringify(families).replace(/</g, '<')` — the embedded
    /// `<script type="application/json">` payload, `<` neutralized to dodge a
    /// `</script>` breakout. "[]" when absent/non-array.
    private static func familiesJsonString(_ families: JSON?) -> String {
        guard let families, families.isArray, let bytes = try? families.encodedBytes(options: .javaScript)
        else { return "[]" }
        var out = ""
        out.reserveCapacity(bytes.count + 8)
        for scalar in String(decoding: bytes, as: UTF8.self).unicodeScalars {
            if scalar == "<" { out += "\\u003c" } else { out.unicodeScalars.append(scalar) }
        }
        return out
    }

    private static func elements(_ node: JSON?) -> [JSON] {
        guard let node, node.isArray else { return [] }
        var out: [JSON] = []
        node.forEachElement { out.append($0) }
        return out
    }

    private static func coerce(_ node: JSON?) -> String {
        guard let node, !node.isNull else { return "" }
        return node.string ?? node.jsString
    }
}

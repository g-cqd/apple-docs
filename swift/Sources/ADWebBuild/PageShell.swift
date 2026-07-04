// The page `<head>` + SEO block + script tags — native port of the head spine of
// `src/web/templates.js` (`buildHead`/`buildSeoBlock`/`buildScripts`). Byte-exact
// against the JS `html` DSL output (2-space-indented SEO lines), escaping via
// `WebHtml.escape` (Bun.escapeHTML semantics).

enum PageShell {
    private static func esc(_ s: String) -> String { WebHtml.escape(s) }

    /// buildHead({...}).
    static func buildHead(
        config: SiteConfig, title: String, description: String? = nil, canonical: String? = nil,
        alternate: String? = nil, ogType: String? = nil, ogTitle: String? = nil,
        ogDesc: String? = nil, jsonLd: String? = nil, robots: String? = nil, headExtra: String? = nil
    ) -> String {
        let cssHref = WebHtml.assetUrl(config, "style.css")
        let headScriptHref = WebHtml.assetUrl(config, config.bundled ? "core.js" : "theme.js")
        let seo = buildSeoBlock(
            config: config, canonical: canonical, alternate: alternate, ogType: ogType,
            ogTitle: ogTitle ?? title, ogDesc: ogDesc ?? description, jsonLd: jsonLd, robots: robots)
        let descMeta = truthy(description) ? "<meta name=\"description\" content=\"\(esc(description!))\">" : ""
        let extra = truthy(headExtra) ? "\n  \(headExtra!)" : ""

        var out = "<head>\n"
        out += "  <meta charset=\"UTF-8\">\n"
        out += "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n"
        out += "  <title>\(esc(title))</title>\n"
        out += "  \(descMeta)\n"
        out += "\(seo)\n"
        out += "  <link rel=\"preload\" href=\"\(esc(cssHref))\" as=\"style\">\n"
        out += "  <link rel=\"stylesheet\" href=\"\(esc(cssHref))\">\n"
        out +=
            "  <link rel=\"search\" type=\"application/opensearchdescription+xml\" title=\"\(esc(config.siteName))\" href=\"\(esc(config.baseUrl))/opensearch.xml\">\(extra)\n"
        out += "  <script src=\"\(esc(headScriptHref))\" defer></script>\n"
        out += "</head>"
        return out
    }

    /// buildSeoBlock({...}) — canonical/alternate/OG/Twitter/JSON-LD, 2-space
    /// indented lines joined with `\n`. Empty when no `canonical`.
    static func buildSeoBlock(
        config: SiteConfig, canonical: String?, alternate: String?, ogType: String?,
        ogTitle: String?, ogDesc: String?, jsonLd: String?, robots: String?
    ) -> String {
        guard let canonical, !canonical.isEmpty else { return "" }
        let altHost = truthy(alternate) ? urlHost(alternate!) : ""
        let altTitle = altHost.isEmpty ? "" : " title=\"Original on \(esc(altHost))\""

        var og: [(String, String)] = [
            ("og:type", ogType ?? "website"),
            ("og:title", ogTitle ?? config.siteName),
            ("og:url", canonical),
            ("og:site_name", config.siteName)
        ]
        if truthy(ogDesc) { og.append(("og:description", ogDesc!)) }

        var lines: [String] = []
        lines.append("  <link rel=\"canonical\" href=\"\(esc(canonical))\">")
        if truthy(alternate) {
            lines.append("  <link rel=\"alternate\" href=\"\(esc(alternate!))\"\(altTitle)>")
        }
        lines.append("  <meta name=\"robots\" content=\"\(esc(robots ?? "index, follow, max-image-preview:large"))\">")
        for (property, content) in og {
            lines.append("  <meta property=\"\(esc(property))\" content=\"\(esc(content))\">")
        }
        lines.append("  <meta name=\"twitter:card\" content=\"summary\">")
        lines.append("  <meta name=\"twitter:title\" content=\"\(esc(ogTitle ?? config.siteName))\">")
        if truthy(ogDesc) {
            lines.append("  <meta name=\"twitter:description\" content=\"\(esc(ogDesc!))\">")
        }
        if truthy(jsonLd) {
            lines.append("  <script type=\"application/ld+json\">\(escapeJsonLd(jsonLd!))</script>")
        }
        return lines.joined(separator: "\n")
    }

    /// Body script tags — bundled (static build) vs individual (dev). Port of
    /// `buildScripts`/`renderScripts`.
    static let bundles: [String: [String]] = [
        "core": ["theme.js", "search.js", "page-toc.js"],
        "listing": ["collection-filters.js", "tree-view.js"]
    ]
    static func buildScripts(_ config: SiteConfig, _ groups: [String]) -> String {
        var files: [String] = []
        if config.bundled {
            for group in groups where group != "core" { files.append("\(group).js") }
        } else {
            for group in groups {
                if let bundle = bundles[group] { files.append(contentsOf: bundle) } else { files.append("\(group).js") }
            }
        }
        return files.enumerated()
            .map { i, file in
                "\(i > 0 ? "\n" : "")<script src=\"\(esc(WebHtml.assetUrl(config, file)))\" defer></script>"
            }
            .joined()
    }

    /// buildHeader(siteConfig) — the global site header (nav + search + theme
    /// switcher). Static chrome but for the home link + site name.
    static func buildHeader(_ config: SiteConfig) -> String {
        let homeHref = "\(config.baseUrl)/"
        return
            "<header class=\"site-header\">\n  <nav class=\"site-nav\">\n    <a class=\"site-name\" href=\"\(esc(homeHref))\">\(esc(config.siteName))</a>\n    <div class=\"search-container\">\n      <input class=\"search-input\" type=\"search\" role=\"combobox\" aria-haspopup=\"listbox\" placeholder=\"Search…\" aria-label=\"Search documentation\" autocomplete=\"off\" aria-expanded=\"false\" aria-controls=\"search-listbox\" aria-activedescendant=\"\" aria-autocomplete=\"list\">\n      <button class=\"search-clear\" type=\"button\" aria-label=\"Clear search\" hidden>&times;</button>\n      <div class=\"search-dropdown\" id=\"search-listbox\" hidden></div>\n      <div id=\"header-search-status\" aria-live=\"assertive\" class=\"sr-only\"></div>\n    </div>\n    <fieldset class=\"theme-switcher\" role=\"radiogroup\" aria-label=\"Color scheme\">\n      <button class=\"theme-option\" type=\"button\" role=\"radio\" data-theme-value=\"light\" aria-label=\"Light theme\"><svg width=\"16\" height=\"16\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><circle cx=\"8\" cy=\"8\" r=\"3\"/><path d=\"M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4\"/></svg></button>\n      <button class=\"theme-option\" type=\"button\" role=\"radio\" data-theme-value=\"auto\" aria-label=\"System theme\"><svg width=\"16\" height=\"16\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><circle cx=\"8\" cy=\"8\" r=\"5.5\"/><path d=\"M8 2.5v11\" fill=\"currentColor\"/><path d=\"M8 2.5A5.5 5.5 0 0 1 8 13.5\" fill=\"currentColor\"/></svg></button>\n      <button class=\"theme-option\" type=\"button\" role=\"radio\" data-theme-value=\"dark\" aria-label=\"Dark theme\"><svg width=\"16\" height=\"16\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M13 9.5A5.5 5.5 0 1 1 6.5 3 4.5 4.5 0 0 0 13 9.5z\"/></svg></button>\n    </fieldset>\n  </nav>\n</header>"
    }

    /// buildFooter(siteConfig) — build date + optional snapshot/commit lines.
    /// `buildDate` comes from the build (the JS `new Date()` fallback is omitted
    /// — the build always sets it).
    static func buildFooter(_ config: SiteConfig) -> String {
        let buildDate = config.buildDate ?? ""
        var snapshotPart = ""
        if truthy(config.snapshotTag) {
            let tag = config.snapshotTag!
            let macos = truthy(config.buildMacos) ? " (macOS \(esc(config.buildMacos!)))" : ""
            snapshotPart =
                " &middot; <span class=\"footer-snapshot\">Snapshot <a href=\"https://github.com/g-cqd/apple-docs/releases/tag/\(esc(tag))\" rel=\"noopener noreferrer\"><code>\(esc(tag))</code></a>\(macos)</span>"
        }
        var commitPart = ""
        if truthy(config.commitHash) {
            let commit = config.commitHash!
            commitPart =
                " &middot; <span class=\"footer-commit\">Commit <a href=\"https://github.com/g-cqd/apple-docs/commit/\(esc(commit))\" rel=\"noopener noreferrer\"><code>\(esc(commit))</code></a></span>"
        }
        return
            "<footer class=\"site-footer\">\n  <p>\n    Built on \(esc(buildDate))\(snapshotPart)\(commitPart)\n    &middot; by <a href=\"https://github.com/g-cqd\" rel=\"noopener noreferrer\">@g-cqd</a>\n    &middot; based on <a href=\"https://developer.apple.com\" rel=\"noopener noreferrer\">Apple Developer Documentation</a>\n  </p>\n</footer>"
    }

    /// escapeJsonLd: a `<`/`>`/`&`-safe `application/ld+json` payload. `json` is
    /// the already-serialized JSON string.
    static func escapeJsonLd(_ json: String) -> String {
        var out = ""
        out.reserveCapacity(json.count)
        for ch in json {
            switch ch {
                case "<": out += "\\u003c"
                case ">": out += "\\u003e"
                case "&": out += "\\u0026"
                default: out.append(ch)
            }
        }
        return out
    }

    /// `new URL(url).host` — the authority (host[:port]), userinfo stripped,
    /// lowercased; "" when unparseable. Foundation-free.
    static func urlHost(_ url: String) -> String {
        let chars = Array(url)
        var start = -1
        var i = 0
        while i + 2 < chars.count {
            if chars[i] == ":", chars[i + 1] == "/", chars[i + 2] == "/" {
                start = i + 3
                break
            }
            i += 1
        }
        guard start >= 0 else { return "" }
        var authority: [Character] = []
        var j = start
        while j < chars.count, chars[j] != "/", chars[j] != "?", chars[j] != "#" {
            authority.append(chars[j])
            j += 1
        }
        if let at = authority.lastIndex(of: "@") { authority = Array(authority[(at + 1)...]) }
        return String(authority).lowercased()
    }

    private static func truthy(_ s: String?) -> Bool { (s.map { !$0.isEmpty }) ?? false }
}

// Static landing pages — port of the per-page templates in src/web/templates/.
// They reuse the page shell (buildHead/header/footer). 404 first.

public enum LandingPages {
    /// renderNotFoundPage(siteConfig). The inline script's surrounding bytes are
    /// CSP-hashed in the JS build — keep them verbatim.
    public static func renderNotFoundPage(_ config: SiteConfig) -> String {
        let pageTitle = "Not Found — \(config.siteName)"
        let head = PageShell.buildHead(
            config: config, title: pageTitle,
            description: "The page you requested could not be found.",
            canonical: "\(config.baseUrl)/", ogType: "website", robots: "noindex")
        return
            "<!DOCTYPE html>\n<html lang=\"en\" data-theme=\"auto\">\n\(head)\n<body>\n<a href=\"#main-content\" class=\"skip-link\">Skip to main content</a>\n\(PageShell.buildHeader(config))\n<main id=\"main-content\" class=\"main-content not-found-page\">\n  <h1>Page not found</h1>\n  <p class=\"not-found-lede\">The page you tried to open isn’t in this corpus.</p>\n  <p class=\"not-found-meta\">\n    <span class=\"not-found-meta__label\">You requested:</span>\n    <code id=\"not-found-url\"></code>\n  </p>\n\n  <form class=\"not-found-search\" role=\"search\" action=\"/search\">\n    <label for=\"not-found-q\" class=\"not-found-search__label\">Search the docs for the title you clicked on:</label>\n    <div class=\"not-found-search__row\">\n      <input type=\"search\" id=\"not-found-q\" name=\"q\" autocomplete=\"off\" autofocus enterkeyhint=\"search\">\n      <button type=\"submit\">Search</button>\n    </div>\n  </form>\n\n  <p class=\"not-found-links\">\n    Or jump to: <a href=\"/\">home</a> · <a href=\"/search/\">search</a> · <a href=\"/fonts/\">fonts</a> · <a href=\"/symbols/\">symbols</a>\n  </p>\n</main>\n\(PageShell.buildFooter(config))\n<script>\(notFoundInlineScript)</script>\n</body>\n</html>"
    }

    /// renderSearchPage(siteConfig) — the static search form scaffold + the
    /// WebSite/SearchAction JSON-LD. (Results are client-rendered by search-page.js.)
    public static func renderSearchPage(_ config: SiteConfig) -> String {
        let pageTitle = "Search — \(config.siteName)"
        let jsonLd = JsonLd.object([
            ("@context", .string("https://schema.org")),
            ("@type", .string("WebSite")),
            ("name", .string(config.siteName)),
            ("url", .string("\(config.baseUrl)/")),
            (
                "potentialAction",
                .object([
                    ("@type", .string("SearchAction")),
                    ("target", .string("\(config.baseUrl)/search?q={query}")),
                    ("query-input", .string("required name=query")),
                ])
            ),
        ])
        let head = PageShell.buildHead(
            config: config, title: pageTitle,
            description: "Search Apple developer documentation with filters.",
            canonical: "\(config.baseUrl)/search", ogType: "website", jsonLd: jsonLd.serialized())
        let script = "<script src=\"\(WebHtml.escape(WebHtml.assetUrl(config, "search-page.js")))\" defer></script>"
        return
            "<!DOCTYPE html>\n<html lang=\"en\" data-theme=\"auto\">\n\(head)\n<body>\n<a href=\"#main-content\" class=\"skip-link\">Skip to main content</a>\n\(PageShell.buildHeader(config))\n<main id=\"main-content\" class=\"main-content search-page\">\n  <h1>Search Documentation</h1>\n\n  <form class=\"search-filters\" id=\"search-form\" role=\"search\">\n    <div class=\"filter-row filter-row-query\">\n      <label class=\"filter-label\" for=\"search-q\">Query</label>\n      <input class=\"filter-input\" id=\"search-q\" name=\"q\" type=\"search\" placeholder=\"Symbol, API, or keyword…\" autocomplete=\"off\">\n    </div>\n\n    <div class=\"filter-row filter-row-selects\">\n      <div class=\"filter-group\">\n        <label class=\"filter-label\" for=\"filter-framework\">Framework</label>\n        <select class=\"filter-select\" id=\"filter-framework\" name=\"framework\" aria-describedby=\"filter-framework-desc\">\n          <option value=\"\">All</option>\n        </select>\n        <span id=\"filter-framework-desc\" class=\"sr-only\">Filter results by framework</span>\n      </div>\n      <div class=\"filter-group\">\n        <label class=\"filter-label\" for=\"filter-kind\">Kind</label>\n        <select class=\"filter-select\" id=\"filter-kind\" name=\"kind\" aria-describedby=\"filter-kind-desc\">\n          <option value=\"\">All</option>\n        </select>\n        <span id=\"filter-kind-desc\" class=\"sr-only\">Filter results by symbol kind</span>\n      </div>\n    </div>\n\n    <div class=\"filter-row filter-row-toggles\">\n      <fieldset class=\"filter-group\">\n        <legend class=\"filter-label\">Language</legend>\n        <div class=\"filter-chips\">\n          <label><input type=\"radio\" name=\"language\" value=\"\" checked> All</label>\n          <label><input type=\"radio\" name=\"language\" value=\"swift\"> Swift</label>\n          <label><input type=\"radio\" name=\"language\" value=\"objc\"> ObjC</label>\n        </div>\n      </fieldset>\n      <fieldset class=\"filter-group\">\n        <legend class=\"filter-label\">Platform</legend>\n        <div class=\"filter-chips\">\n          <label><input type=\"checkbox\" name=\"platform\" value=\"ios\"> iOS</label>\n          <label><input type=\"checkbox\" name=\"platform\" value=\"macos\"> macOS</label>\n          <label><input type=\"checkbox\" name=\"platform\" value=\"watchos\"> watchOS</label>\n          <label><input type=\"checkbox\" name=\"platform\" value=\"tvos\"> tvOS</label>\n          <label><input type=\"checkbox\" name=\"platform\" value=\"visionos\"> visionOS</label>\n        </div>\n      </fieldset>\n    </div>\n\n    <details class=\"filter-advanced\">\n      <summary>Advanced filters</summary>\n      <div class=\"filter-row filter-row-versions\">\n        <div class=\"filter-group\">\n          <label class=\"filter-label\" for=\"filter-min-ios\">Min iOS</label>\n          <input class=\"filter-input filter-input-sm\" id=\"filter-min-ios\" name=\"min_ios\" type=\"text\" placeholder=\"e.g. 17.0\">\n        </div>\n        <div class=\"filter-group\">\n          <label class=\"filter-label\" for=\"filter-min-macos\">Min macOS</label>\n          <input class=\"filter-input filter-input-sm\" id=\"filter-min-macos\" name=\"min_macos\" type=\"text\" placeholder=\"e.g. 14.0\">\n        </div>\n        <div class=\"filter-group\">\n          <label class=\"filter-label\" for=\"filter-min-watchos\">Min watchOS</label>\n          <input class=\"filter-input filter-input-sm\" id=\"filter-min-watchos\" name=\"min_watchos\" type=\"text\" placeholder=\"e.g. 10.0\">\n        </div>\n        <div class=\"filter-group\">\n          <label class=\"filter-label\" for=\"filter-min-tvos\">Min tvOS</label>\n          <input class=\"filter-input filter-input-sm\" id=\"filter-min-tvos\" name=\"min_tvos\" type=\"text\" placeholder=\"e.g. 17.0\">\n        </div>\n        <div class=\"filter-group\">\n          <label class=\"filter-label\" for=\"filter-min-visionos\">Min visionOS</label>\n          <input class=\"filter-input filter-input-sm\" id=\"filter-min-visionos\" name=\"min_visionos\" type=\"text\" placeholder=\"e.g. 1.0\">\n        </div>\n      </div>\n      <div class=\"filter-row\">\n        <div class=\"filter-group\">\n          <label class=\"filter-label\" for=\"filter-year\">WWDC Year</label>\n          <select class=\"filter-select\" id=\"filter-year\" name=\"year\" aria-describedby=\"filter-year-desc\">\n            <option value=\"\">Any</option>\n          </select>\n          <span id=\"filter-year-desc\" class=\"sr-only\">Filter results by WWDC session year</span>\n        </div>\n        <div class=\"filter-group\">\n          <label class=\"filter-label\" for=\"filter-track\">WWDC Track</label>\n          <input class=\"filter-input filter-input-sm\" id=\"filter-track\" name=\"track\" type=\"text\" placeholder=\"e.g. SwiftUI\">\n        </div>\n      </div>\n      <div class=\"filter-row\">\n        <label class=\"filter-checkbox\"><input type=\"checkbox\" name=\"fuzzy\" value=\"1\"> Include typo/fuzzy matching</label>\n        <label class=\"filter-checkbox\"><input type=\"checkbox\" name=\"deep\" value=\"1\"> Include full-text body search</label>\n      </div>\n    </details>\n\n    <div class=\"filter-row filter-row-actions\">\n      <button type=\"submit\" class=\"filter-button\">Search</button>\n    </div>\n  </form>\n\n  <div id=\"search-status\" class=\"search-status\" role=\"status\" hidden></div>\n  <div id=\"search-results\" class=\"search-results\"></div>\n  <button id=\"search-load-more\" class=\"load-more\" hidden aria-label=\"Load more search results\">Load more results</button>\n</main>\n\(PageShell.buildFooter(config))\n\(script)\n</body>\n</html>"
    }

    /// `NOT_FOUND_INLINE_SCRIPT` — verbatim (leading + trailing newline; literal
    /// regex backslashes preserved via the raw literal).
    static let notFoundInlineScript = "\n" + #"""
        (function () {
          // Derive a search-friendly query from the requested URL. The terminal
          // path segment is the most likely page name; humanize CamelCase / kebab-
          // case / snake_case and decode percent escapes so users land on the
          // search page with a meaningful pre-filled query instead of a blank box.
          var url = window.location;
          var displayUrl = (url.pathname || '') + (url.search || '') + (url.hash || '');
          var urlEl = document.getElementById('not-found-url');
          if (urlEl) urlEl.textContent = displayUrl;

          var path = (url.pathname || '').replace(/\/+$/, '').replace(/^\/+/, '');
          // Drop /docs/ prefix and known framework segments — they're not the
          // search target. Keep only the last two segments at most so multi-level
          // misses (e.g. /docs/foo/bar/baz) yield "bar baz".
          if (path.indexOf('docs/') === 0) path = path.slice(5);
          var segs = path.split('/').filter(Boolean).slice(-2);
          var raw = segs.join(' ');
          var pretty = '';
          try { pretty = decodeURIComponent(raw); } catch (_) { pretty = raw; }
          pretty = pretty
            .replace(/[-_]+/g, ' ')                  // kebab/snake → space
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // CamelCase split
            .replace(/\.html?$/i, '')               // drop terminal .html
            .replace(/\s+/g, ' ')
            .trim();

          var input = document.getElementById('not-found-q');
          if (input && pretty) {
            input.value = pretty;
            // Pre-select so a single keystroke replaces the inferred query.
            input.select();
          }
        })();
        """# + "\n"
}

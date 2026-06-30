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

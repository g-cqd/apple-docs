/// Sitemap protocol 0.9 documents: a `<sitemapindex>` over per-framework `<urlset>` files.
public enum WebSitemap {
    /// Sitemap protocol cap on URLs per `<urlset>`.
    public static let maxURLsPerSitemap = 50_000

    /// Pseudo-slug of the urlset holding the site's top-level pages.
    public static let rootSitemapSlug = "_root"

    /// Top-level pages listed in the root urlset.
    public static let rootPaths = ["/", "/search", "/symbols", "/fonts"]

    /// Whether `slug` is a safe sitemap file stem (lowercase letters, digits, `.`, `_`, `-`; no leading dot).
    public static func isValidSlug(_ slug: String) -> Bool {
        guard !slug.isEmpty, slug.utf8.count <= 128, !slug.hasPrefix(".") else { return false }
        return slug.utf8.allSatisfy { byte in
            (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x30 && byte <= 0x39) || byte == 0x2E || byte == 0x5F
                || byte == 0x2D
        }
    }

    /// The `<sitemapindex>` pointing at `/sitemaps/_root.xml` and one `/sitemaps/<slug>.xml` per framework.
    public static func indexXML(baseURL: String, frameworkSlugs: [String]) -> String {
        let entries = ([rootSitemapSlug] + frameworkSlugs.filter(isValidSlug))
            .map { slug in
                "  <sitemap><loc>\(WebHTMLRenderer.escapeHTML("\(baseURL)/sitemaps/\(slug).xml"))</loc></sitemap>"
            }
        return document(root: "sitemapindex", entries: entries)
    }

    /// A `<urlset>` of absolute page URLs for `paths` (site-relative, e.g. `/doc/swiftui/view`), capped.
    public static func urlSetXML(baseURL: String, paths: [String]) -> String {
        let entries = paths.prefix(maxURLsPerSitemap)
            .map { path in
                "  <url><loc>\(WebHTMLRenderer.escapeHTML(baseURL + path))</loc></url>"
            }
        return document(root: "urlset", entries: Array(entries))
    }

    private static func document(root: String, entries: [String]) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <\(root) xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        \(entries.joined(separator: "\n"))
        </\(root)>

        """
    }
}

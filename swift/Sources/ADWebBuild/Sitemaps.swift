// S4 — sitemap generation (src/web/sitemap.js): the uncompressed
// `sitemap.xml` index + one gzipped urlset per framework + the `_root` urlset
// (homepage / search / symbols / fonts). Pure: this plans the XML text; the
// driver applies the gzip seam (ADArchive.Gzip — see its byte-parity note:
// bun's deflate bitstream differs from classic zlib, so *.gz artifacts are
// compared by GUNZIPPED content in the gate).

import ADBase

/// One document row for a framework's sitemap (`SELECT key, role_heading FROM
/// documents WHERE framework = ? ORDER BY key`).
public struct SitemapDoc: Sendable {
    public let key: String
    public let roleHeading: String?
    public init(key: String, roleHeading: String?) {
        self.key = key
        self.roleHeading = roleHeading
    }
}

/// One root for the sitemap walk (`getRoots()` = every root, ORDER BY slug —
/// including roots the homepage filter would drop).
public struct SitemapRoot: Sendable {
    public let slug: String
    public let kind: String?
    public let docs: [SitemapDoc]
    public init(slug: String, kind: String?, docs: [SitemapDoc]) {
        self.slug = slug
        self.kind = kind
        self.docs = docs
    }
}

/// One planned sitemap file: the XML text plus whether the driver gzips it
/// (`sitemaps/*.xml.gz` are compressed; the index `sitemap.xml` is not — some
/// bots reject gzipped indexes).
public struct SitemapFile: Sendable {
    public let path: String
    public let xml: String
    public let gzipped: Bool
}

/// `framework <slug> has N docs — exceeds the per-sitemap cap` (AssertionError).
public struct SitemapCapExceeded: Error, Sendable {
    public let slug: String
    public let docCount: Int
}

extension BuildSite {
    /// `URLS_PER_SITEMAP` — the sitemap-spec cap per urlset.
    static let urlsPerSitemap = 50_000

    /// Port of `generateSitemaps` as a pure plan. `buildDate` feeds `<lastmod>`
    /// (omitted when empty — JS falsy). File order: `sitemaps/_root.xml.gz`,
    /// one `sitemaps/<slug>.xml.gz` per non-empty root (input order = the JS
    /// `getRoots()` ORDER BY slug), then the uncompressed `sitemap.xml` index.
    public static func planSitemaps(
        roots: [SitemapRoot], baseUrl: String, buildDate: String
    ) throws(SitemapCapExceeded) -> [SitemapFile] {
        // `baseUrl.replace(/\/+$/, '')`.
        let cleanBase = stripTrailingSlashes(baseUrl)
        let lastmod = buildDate

        var files: [SitemapFile] = []

        // _root: homepage + search + the curated design tools.
        let rootEntries = [
            urlEntry(loc: "\(cleanBase)/", lastmod: lastmod, changefreq: "daily", priority: 1.0),
            urlEntry(loc: "\(cleanBase)/search", lastmod: lastmod, changefreq: "monthly", priority: 0.7),
            urlEntry(loc: "\(cleanBase)/symbols", lastmod: lastmod, changefreq: "weekly", priority: 0.7),
            urlEntry(loc: "\(cleanBase)/fonts", lastmod: lastmod, changefreq: "weekly", priority: 0.7),
        ]
        files.append(SitemapFile(path: "sitemaps/_root.xml.gz", xml: urlset(rootEntries), gzipped: true))

        var writtenSlugs: [String] = []
        for root in roots where !root.docs.isEmpty {
            let xml = try frameworkSitemapXml(root: root, baseUrl: cleanBase, lastmod: lastmod)
            files.append(SitemapFile(path: "sitemaps/\(root.slug).xml.gz", xml: xml, gzipped: true))
            writtenSlugs.append(root.slug)
        }

        files.append(
            SitemapFile(
                path: "sitemap.xml",
                xml: sitemapIndexXml(baseUrl: cleanBase, frameworkSlugs: writtenSlugs, lastmod: lastmod),
                gzipped: false))
        return files
    }

    /// `buildFrameworkSitemapXml` — the landing entry (kind defaults) + one
    /// entry per doc (release-notes roots/headings bump changefreq to weekly).
    private static func frameworkSitemapXml(
        root: SitemapRoot, baseUrl: String, lastmod: String
    ) throws(SitemapCapExceeded) -> String {
        let defaults = kindDefaults(root.kind)
        var entries: [String] = [
            urlEntry(
                loc: "\(baseUrl)/docs/\(root.slug)/", lastmod: lastmod,
                changefreq: defaults.changefreq, priority: defaults.priority)
        ]
        if root.docs.count + 1 > urlsPerSitemap {
            throw SitemapCapExceeded(slug: root.slug, docCount: root.docs.count)
        }
        for doc in root.docs {
            let isReleaseNotes = root.kind == "release-notes" || hasReleaseNotesHint(doc.roleHeading)
            entries.append(
                urlEntry(
                    loc: "\(baseUrl)/docs/\(SafePath.safeWebDocKey(doc.key))/", lastmod: lastmod,
                    changefreq: isReleaseNotes ? "weekly" : "monthly", priority: 0.6))
        }
        return urlset(entries)
    }

    /// `buildSitemapIndexXml`.
    private static func sitemapIndexXml(baseUrl: String, frameworkSlugs: [String], lastmod: String) -> String {
        let blocks = (["_root"] + frameworkSlugs).map { slug in
            [
                "  <sitemap>",
                "    <loc>\(escapeXml("\(baseUrl)/sitemaps/\(slug).xml.gz"))</loc>",
                "    <lastmod>\(escapeXml(lastmod))</lastmod>",
                "  </sitemap>",
            ].joined(separator: "\n")
        }
        return [
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
            "<sitemapindex xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">",
            blocks.joined(separator: "\n"),
            "</sitemapindex>",
            "",
        ].joined(separator: "\n")
    }

    /// One `<url>` block. `lastmod`/`changefreq` are omitted when empty (JS
    /// truthiness); priority always prints with one decimal (`toFixed(1)`).
    private static func urlEntry(loc: String, lastmod: String, changefreq: String, priority: Double) -> String {
        var parts = ["  <url>", "    <loc>\(escapeXml(loc))</loc>"]
        if !lastmod.isEmpty { parts.append("    <lastmod>\(escapeXml(lastmod))</lastmod>") }
        if !changefreq.isEmpty { parts.append("    <changefreq>\(escapeXml(changefreq))</changefreq>") }
        parts.append("    <priority>\(toFixed1(priority))</priority>")
        parts.append("  </url>")
        return parts.joined(separator: "\n")
    }

    private static func urlset(_ entries: [String]) -> String {
        [
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
            "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">",
            entries.joined(separator: "\n"),
            "</urlset>",
            "",
        ].joined(separator: "\n")
    }

    /// KIND_DEFAULTS[kind] ?? DOC_DEFAULT.
    private static func kindDefaults(_ kind: String?) -> (priority: Double, changefreq: String) {
        switch kind {
        case "framework": return (0.8, "weekly")
        case "tooling": return (0.7, "monthly")
        case "guidelines": return (0.7, "monthly")
        case "collection": return (0.6, "weekly")
        case "design": return (0.7, "monthly")
        case "release-notes": return (0.7, "weekly")
        case "technology": return (0.6, "monthly")
        default: return (0.6, "monthly")
        }
    }

    /// `/release-notes/i` — case-insensitive substring over role_heading ?? ''.
    private static func hasReleaseNotesHint(_ roleHeading: String?) -> Bool {
        guard let roleHeading else { return false }
        let needle = Array("release-notes".unicodeScalars)
        let hay = roleHeading.unicodeScalars.map(asciiLower)
        if hay.count < needle.count { return false }
        for start in 0...(hay.count - needle.count) {
            var match = true
            for i in 0..<needle.count where hay[start + i] != needle[i] {
                match = false
                break
            }
            if match { return true }
        }
        return false
    }

    private static func asciiLower(_ s: Unicode.Scalar) -> Unicode.Scalar {
        (s.value >= 65 && s.value <= 90) ? Unicode.Scalar(s.value + 32)! : s
    }

    /// XML escape (& < > " ') for text/attribute contexts.
    static func escapeXml(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for scalar in s.unicodeScalars {
            switch scalar {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&apos;"
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    /// `Number.prototype.toFixed(1)` over the sitemap priority domain
    /// (0.0…1.0 in tenths): scale, round half-away like toFixed's decimal
    /// rendering of these exact values, print `d.d`.
    static func toFixed1(_ value: Double) -> String {
        let tenths = Int((value * 10).rounded())
        return "\(tenths / 10).\(tenths % 10)"
    }

    /// `replace(/\/+$/, '')`.
    static func stripTrailingSlashes(_ s: String) -> String {
        var scalars = Array(s.unicodeScalars)
        while scalars.last == "/" { scalars.removeLast() }
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars)
        return String(view)
    }
}

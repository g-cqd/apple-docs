import Testing

@testable import ADWebBuild

// S4 sitemaps: planSitemaps byte-exact vs the bun oracle — generateSitemaps
// run over a stub db (fixtures pinned from the actual files it wrote,
// gunzipped). Exercises: trailing-slash baseUrl cleanup, kind defaults +
// unknown kind, the release-notes changefreq hint (root kind AND role_heading
// regex), XML escaping, empty-root skipping, and the file/index ordering.

private let sitemapRootsFixture = [
    SitemapRoot(slug: "emptyfw", kind: "framework", docs: []),  // skipped (no docs)
    SitemapRoot(slug: "notes", kind: "release-notes", docs: [SitemapDoc(key: "notes/only", roleHeading: nil)]),
    SitemapRoot(
        slug: "swiftui", kind: "framework",
        docs: [
            SitemapDoc(key: "swiftui", roleHeading: nil),
            SitemapDoc(key: "swiftui/view", roleHeading: "Protocol"),
            SitemapDoc(key: "swiftui/notes", roleHeading: "SwiftUI Release-Notes 2026"),
        ]),
    SitemapRoot(slug: "zz", kind: nil, docs: [SitemapDoc(key: "zz/&<doc>\"quo'x", roleHeading: "x")]),
]

/// gunzip(sitemaps/swiftui.xml.gz) from the bun run.
private let swiftuiXmlExpected =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n  <url>\n    <loc>https://x.test/docs/swiftui/</loc>\n    <lastmod>2026-06-30</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n  <url>\n    <loc>https://x.test/docs/swiftui/</loc>\n    <lastmod>2026-06-30</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n  <url>\n    <loc>https://x.test/docs/swiftui/view/</loc>\n    <lastmod>2026-06-30</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n  <url>\n    <loc>https://x.test/docs/swiftui/notes/</loc>\n    <lastmod>2026-06-30</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>\n</urlset>\n"

/// gunzip(sitemaps/zz.xml.gz) — nil kind ⇒ DOC_DEFAULT landing + XML escapes.
private let zzXmlExpected =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n  <url>\n    <loc>https://x.test/docs/zz/</loc>\n    <lastmod>2026-06-30</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n  <url>\n    <loc>https://x.test/docs/zz/&amp;&lt;doc&gt;&quot;quo&apos;x/</loc>\n    <lastmod>2026-06-30</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n</urlset>\n"

/// gunzip(sitemaps/_root.xml.gz).
private let rootXmlExpected =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n  <url>\n    <loc>https://x.test/</loc>\n    <lastmod>2026-06-30</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n  <url>\n    <loc>https://x.test/search</loc>\n    <lastmod>2026-06-30</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n  <url>\n    <loc>https://x.test/symbols</loc>\n    <lastmod>2026-06-30</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>\n  <url>\n    <loc>https://x.test/fonts</loc>\n    <lastmod>2026-06-30</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>\n</urlset>\n"

/// sitemap.xml (the uncompressed index).
private let indexXmlExpected =
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<sitemapindex xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n  <sitemap>\n    <loc>https://x.test/sitemaps/_root.xml.gz</loc>\n    <lastmod>2026-06-30</lastmod>\n  </sitemap>\n  <sitemap>\n    <loc>https://x.test/sitemaps/notes.xml.gz</loc>\n    <lastmod>2026-06-30</lastmod>\n  </sitemap>\n  <sitemap>\n    <loc>https://x.test/sitemaps/swiftui.xml.gz</loc>\n    <lastmod>2026-06-30</lastmod>\n  </sitemap>\n  <sitemap>\n    <loc>https://x.test/sitemaps/zz.xml.gz</loc>\n    <lastmod>2026-06-30</lastmod>\n  </sitemap>\n</sitemapindex>\n"

private func sitemapXml(_ files: [SitemapFile], _ path: String) -> String? {
    files.first { $0.path == path }?.xml
}

@Test func sitemapPlanMatchesBunOracle() throws {
    // baseUrl carries a trailing slash — cleanBase must strip it.
    let files = try BuildSite.planSitemaps(
        roots: sitemapRootsFixture, baseUrl: "https://x.test/", buildDate: "2026-06-30")

    // Order: _root, per-root (input order, empties skipped), index last.
    let paths: [String] = files.map(\.path)
    #expect(
        paths == [
            "sitemaps/_root.xml.gz", "sitemaps/notes.xml.gz", "sitemaps/swiftui.xml.gz",
            "sitemaps/zz.xml.gz", "sitemap.xml",
        ])
    #expect(files.map(\.gzipped) == [true, true, true, true, false])

    #expect(sitemapXml(files, "sitemaps/_root.xml.gz") == rootXmlExpected)
    #expect(sitemapXml(files, "sitemaps/swiftui.xml.gz") == swiftuiXmlExpected)
    #expect(sitemapXml(files, "sitemaps/zz.xml.gz") == zzXmlExpected)
    #expect(sitemapXml(files, "sitemap.xml") == indexXmlExpected)
}

@Test func sitemapReleaseNotesKindAndEmptyLastmod() throws {
    // release-notes ROOT kind: weekly/0.7 landing + weekly docs (bun oracle).
    let files = try BuildSite.planSitemaps(
        roots: sitemapRootsFixture, baseUrl: "https://x.test", buildDate: "2026-06-30")
    let notes = sitemapXml(files, "sitemaps/notes.xml.gz") ?? ""
    #expect(notes.contains("<loc>https://x.test/docs/notes/</loc>\n    <lastmod>2026-06-30</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>"))
    #expect(notes.contains("<loc>https://x.test/docs/notes/only/</loc>\n    <lastmod>2026-06-30</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>"))

    // Empty buildDate is JS-falsy ⇒ no <lastmod> line anywhere.
    let noDate = try BuildSite.planSitemaps(roots: [], baseUrl: "https://x.test", buildDate: "")
    #expect(!(sitemapXml(noDate, "sitemaps/_root.xml.gz") ?? "").contains("<lastmod>"))
}

@Test func sitemapCapThrows() {
    let docs = (0..<50_000).map { SitemapDoc(key: "big/doc\($0)", roleHeading: nil) }
    let roots = [SitemapRoot(slug: "big", kind: "framework", docs: docs)]
    #expect(throws: SitemapCapExceeded.self) {
        try BuildSite.planSitemaps(roots: roots, baseUrl: "https://x.test", buildDate: "2026-06-30")
    }
}

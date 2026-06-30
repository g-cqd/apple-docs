import Testing

@testable import ADWebBuild

@Test func escapeUsesBunEntities() {
    // Apostrophe is &#x27; (Bun.escapeHTML), NOT &#39;.
    #expect(WebHtml.escape("a & b < c > \"d\" 'e'") == "a &amp; b &lt; c &gt; &quot;d&quot; &#x27;e&#x27;")
    #expect(WebHtml.escape("Apple's API") == "Apple&#x27;s API")
}

@Test func assetUrlAppendsVersion() {
    let plain = SiteConfig(baseUrl: "https://x.test")
    #expect(WebHtml.assetUrl(plain, "style.css") == "https://x.test/assets/style.css")
    let versioned = SiteConfig(baseUrl: "https://x.test", assetVersion: "a b")
    #expect(WebHtml.assetUrl(versioned, "style.css") == "https://x.test/assets/style.css?v=a%20b")
    // Empty version → no query.
    let empty = SiteConfig(baseUrl: "", assetVersion: "")
    #expect(WebHtml.assetUrl(empty, "core.js") == "/assets/core.js")
}

@Test func frameworkOriginalUrlSynthesis() {
    #expect(WebHtml.frameworkOriginalUrl(sourceType: nil, slug: nil, url: "https://u") == "https://u")
    #expect(WebHtml.frameworkOriginalUrl(sourceType: "hig", slug: "x", url: nil) == "https://developer.apple.com/design/human-interface-guidelines")
    #expect(WebHtml.frameworkOriginalUrl(sourceType: "swift-org", slug: nil, url: nil) == "https://www.swift.org/")
    #expect(WebHtml.frameworkOriginalUrl(sourceType: nil, slug: "swiftui", url: nil) == "https://developer.apple.com/documentation/swiftui")
    #expect(WebHtml.frameworkOriginalUrl(sourceType: nil, slug: nil, url: nil) == nil)
}

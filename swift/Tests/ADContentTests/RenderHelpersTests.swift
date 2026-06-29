import Testing

@testable import ADContent

@Test func escapesHtmlInJsOrder() {
    #expect(
        RenderHelpers.escapeHtml("a & b < c > d \" e ' f")
            == "a &amp; b &lt; c &gt; d &quot; e &#39; f")
    // Ampersand first, so existing entities double-escape exactly like the JS.
    #expect(RenderHelpers.escapeHtml("&amp;") == "&amp;amp;")
}

@Test func slugifies() {
    #expect(RenderHelpers.slugify("Hello World") == "hello-world")
    #expect(RenderHelpers.slugify("Possible Values") == "possible-values")
    #expect(RenderHelpers.slugify("  Spaces  &  Punct!!  ") == "spaces-punct")
    #expect(RenderHelpers.slugify("--leading-and-trailing--") == "leading-and-trailing")
    #expect(RenderHelpers.slugify("") == "")
}

@Test func isSafeHref() {
    #expect(RenderHelpers.isSafeHref("#frag"))
    #expect(RenderHelpers.isSafeHref("/docs/x/"))
    #expect(RenderHelpers.isSafeHref("https://x.com"))
    #expect(RenderHelpers.isSafeHref("HTTP://x.com"))  // case-insensitive
    #expect(!RenderHelpers.isSafeHref("//evil.com"))  // protocol-relative rejected
    #expect(!RenderHelpers.isSafeHref("javascript:alert(1)"))
    #expect(!RenderHelpers.isSafeHref(""))
}

@Test func readableNameFromKey() {
    #expect(RenderHelpers.readableNameFromKey("swiftui/animation/linear") == "Linear")
    #expect(RenderHelpers.readableNameFromKey("foo-bar-baz") == "Foo Bar Baz")
    #expect(RenderHelpers.readableNameFromKey("") == "")
}

@Test func resolvesReferenceUrls() {
    // Direct https URL → title from the last segment.
    #expect(
        RenderHelpers.resolveReferenceUrl("https://example.com/some-page.html")
            == RenderHelpers.ReferenceURL(href: "https://example.com/some-page.html", title: "Some Page"))
    // doc:// WWDC video reference.
    #expect(
        RenderHelpers.resolveReferenceUrl("doc://com.apple.documentation/videos/play/wwdc2025/281")
            == RenderHelpers.ReferenceURL(
                href: "https://developer.apple.com/videos/play/wwdc2025/281/",
                title: "WWDC2025 Session 281"))
    // doc:// non-documentation path.
    #expect(
        RenderHelpers.resolveReferenceUrl("doc://com.apple.documentation/tutorials/swiftui")
            == RenderHelpers.ReferenceURL(
                href: "https://developer.apple.com/tutorials/swiftui", title: "Swiftui"))
    #expect(RenderHelpers.resolveReferenceUrl("notaurl") == nil)
    #expect(RenderHelpers.resolveReferenceUrl("") == nil)
}

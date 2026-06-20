// Gate for HtmlNormalize — the HTML-page → NormalizedPage mapping over ADHTMLCore's extractor.
// Confirms title/description/abstract/headings resolution, the abstract-vs-lead section dedup, and
// redirect-stub detection.

import Testing

@testable import ADBuilder

struct HtmlNormalizeTests {
    @Test func mapsExtractedPageToNormalizedModel() {
        let html = """
            <html><head><title>Generics</title><meta name="description" content="Write flexible code."></head>
            <body><nav>chrome</nav><main><h1>Generics</h1><p>Intro.</p>
            <h2>Why</h2><p>Reasons.</p></main></body></html>
            """
        let page = HtmlNormalize.parse(
            html, key: "swift/generics", sourceType: "swift-org", language: "swift",
            preserveStructure: true)

        #expect(page.document.key == "swift/generics")
        #expect(page.document.sourceType == "swift-org")
        #expect(page.document.language == "swift")
        #expect(page.document.title == "Generics")
        #expect(page.document.abstractText == "Write flexible code.")
        #expect(page.document.headings == "Why")

        // description → abstract section; the lead is skipped (captured by the abstract); then "Why".
        #expect(page.sections.count == 2)
        #expect(page.sections[0].sectionKind == "abstract")
        #expect(page.sections[0].contentText == "Write flexible code.")
        #expect(page.sections[1].sectionKind == "discussion")
        #expect(page.sections[1].heading == "Why")
        #expect(page.sections[1].contentText == "Reasons.")
    }

    @Test func abstractFallsBackToLeadParagraphWithoutDescription() {
        let html = "<main><p>First para.</p><p>Second.</p><h2>S</h2><p>body</p></main>"
        let page = HtmlNormalize.parse(html, key: "k", sourceType: "swift-org")
        // No meta description → abstract is the first paragraph (block) of the lead; the lead survives.
        #expect(page.document.abstractText == "First para.")
        #expect(page.sections.contains { $0.heading == "S" && $0.contentText == "body" })
    }

    @Test func detectsRedirectStub() {
        let html = "<html><head><meta http-equiv=\"refresh\" content=\"0; url=/new/path\"></head></html>"
        let page = HtmlNormalize.parse(html, key: "old/path", sourceType: "swift-org")
        #expect(page.document.kind == "redirect")
        #expect(page.document.url == "/new/path")
        #expect(page.sections.first?.heading == "Page Moved")
    }
}

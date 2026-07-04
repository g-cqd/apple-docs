// GuidelinesParser vs the bun oracle — parseGuidelinesHtml run over the same
// fixture (markers/strips, htmlToMarkdown, title/number/abstract extraction,
// hierarchy, lastUpdated) with every field pinned. The fixture exercises: h3 +
// li sidenav sections, empty data-sidenav (markdown-first-line title), data-nr,
// badge/localization span stripping, strong buffering, link absolutizing,
// code/em, disc + ordered lists, entities (incl. &#39;/&lt;/&amp;), &nbsp;,
// the outside-container sidenav ignore, and the Last Updated anchor.

import Testing

@testable import ADBuilder

private let guidelinesFixture = """
    <!DOCTYPE html>
    <html>
    <head><title>App Store Review Guidelines</title></head>
    <body>
    <nav class="sidenav-container"><ul><li data-sidenav="Ignored Outside">nope</li></ul></nav>
    <div id="content-container" class="content">
      <p>Last Updated: <a href="/news/">June 9, 2025</a></p>
      <p>Apps are changing the world.</p>
      <h3 id="safety" data-sidenav="Safety">1. Safety</h3>
      <p>When people install an app, they want to know <strong>it is safe</strong>. See <a href="/support/">support</a> &amp; more.</p>
      <ul class="no-bullet">
        <li id="1.1" data-sidenav="1.1 Objectionable Content" data-nr>
          <p>Apps should not include content that is <em>offensive</em>. Use <code>UIKit</code> wisely.</p>
          <ul class="list-disc">
            <li>Defamatory content; realistic portrayals.</li>
            <li>Content that is discriminatory. It hurts.</li>
          </ul>
          <span class="custom-tooltip-icon"><img src="badge.png"><span>ASR</span></span>
          <span class="loc-en-only">EN only marker</span>
        </li>
        <li id="1.1.1" data-sidenav="">
          <p>1.1.1 First subrule. Details follow here. More text.</p>
        </li>
        <li id="1.2" data-sidenav="1.2 User-Generated Content">
          <p>UGC apps &#39;must&#39; include a method for filtering &lt;objectionable&gt; material.</p>
          <ol><li>Filter it.</li><li>Report it.</li></ol>
        </li>
      </ul>
      <h3 id="business" data-sidenav="Business">2. Business</h3>
      <p>There are many ways to monetize your app.&nbsp;Choose wisely.</p>
    </div>
    </body>
    </html>
    """

private let safetyMarkdown =
    "### 1. Safety\n\nWhen people install an app, they want to know **it is safe**. See [support](https://developer.apple.com/support/) & more."
private let objectionableMarkdown =
    "Apps should not include content that is *offensive*. Use `UIKit` wisely.\n\n- Defamatory content; realistic portrayals.\n\n- Content that is discriminatory. It hurts."
private let ugcMarkdown =
    "UGC apps 'must' include a method for filtering <objectionable> material.\n\n1. Filter it.\n1. Report it."

// Expected projections hoisted to file scope as typed `let` so the two split assertions below
// stay well under the 100ms type-check budget (array-literal inference is the budget cost here).
private let expectedIds = ["safety", "1.1", "1.1.1", "1.2", "business"]
private let expectedPaths = [
    "app-store-review/safety", "app-store-review/1.1", "app-store-review/1.1.1",
    "app-store-review/1.2", "app-store-review/business"
]
private let expectedRoles = ["collection", "article", "article", "article", "collection"]
private let expectedRoleHeadings = ["Section", "Guideline", "Guideline", "Guideline", "Section"]
private let expectedNotarization = [false, true, false, false, false]
private let expectedSectionNumbers: [String?] = [nil, "1.1", "1.1.1", "1.2", nil]

@Test func guidelinesParseStructureMatchesBunOracle() throws {
    let result = try GuidelinesParser.parse(guidelinesFixture)
    #expect(result.lastUpdated == "June 9, 2025")
    #expect(result.sections.map(\.id) == expectedIds)
    #expect(result.sections.map(\.path) == expectedPaths)
    #expect(result.sections.map(\.role) == expectedRoles)
}

@Test func guidelinesParseMetadataMatchesBunOracle() throws {
    let result = try GuidelinesParser.parse(guidelinesFixture)
    #expect(result.sections.map(\.roleHeading) == expectedRoleHeadings)
    #expect(result.sections.map(\.notarization) == expectedNotarization)
    #expect(result.sections.map(\.sectionNumber) == expectedSectionNumbers)
    // Hierarchy: 1.1 parents 1.1.1 (top h3 sections carry no number).
    #expect(result.sections[1].children == ["app-store-review/1.1.1"])
    #expect(result.sections[0].children.isEmpty)
}

@Test func guidelinesTitlesAndAbstractsMatchBunOracle() throws {
    let result = try GuidelinesParser.parse(guidelinesFixture)
    #expect(
        result.sections.map(\.title) == [
            "Safety", "1.1 Objectionable Content", "1.1.1 First subrule. Details follow here. More text.",
            "1.2 User-Generated Content", "Business"
        ])
    #expect(
        result.sections.map(\.abstract) == [
            "When people install an app, they want to know it is safe.",
            "Apps should not include content that is *offensive*.",
            "1.1.1 First subrule.",
            "UGC apps 'must' include a method for filtering <objectionable> material.",
            "There are many ways to monetize your app."
        ])
}

@Test func guidelinesMarkdownMatchesBunOracle() throws {
    let result = try GuidelinesParser.parse(guidelinesFixture)
    #expect(result.sections[0].markdown == safetyMarkdown)
    #expect(result.sections[1].markdown == objectionableMarkdown)
    #expect(result.sections[2].markdown == "1.1.1 First subrule. Details follow here. More text.")
    #expect(result.sections[3].markdown == ugcMarkdown)
    #expect(
        result.sections[4].markdown == "### 2. Business\n\nThere are many ways to monetize your app. Choose wisely.")
}

@Test func guidelinesNormalizeProjectsSection() throws {
    let result = try GuidelinesParser.parse(guidelinesFixture)
    let section = result.sections[1]  // 1.1 with a child
    let page = GuidelinesAdapter.normalizeGuidelines(section, key: section.path)
    #expect(page.document.sourceType == "guidelines")
    #expect(page.document.title == "1.1 Objectionable Content")
    #expect(page.document.kind == "article")
    #expect(page.document.roleHeading == "Guideline")
    #expect(page.document.framework == "app-store-review")
    #expect(page.document.url == "https://developer.apple.com/app-store/review/guidelines/#1.1")
    #expect(page.document.urlDepth == 1)
    #expect(page.sections.map(\.sectionKind) == ["abstract", "discussion"])
    #expect(page.sections[1].heading == "Overview")
    #expect(page.sections[1].contentText == objectionableMarkdown)
    #expect(page.relationships.count == 1)
    #expect(page.relationships[0].toKey == "app-store-review/1.1.1")
    #expect(page.relationships[0].relationType == "child")
    #expect(page.relationships[0].section == "Topics")
}

@Test func guidelinesNormalizeRootCase() {
    // The ROOT normalize (nil section — the JS bare-payload path).
    let root = GuidelinesAdapter.normalizeGuidelines(nil, key: "app-store-review")
    #expect(root.document.title == nil)
    #expect(root.document.kind == "article")
    #expect(root.document.url == "https://developer.apple.com/app-store/review/guidelines/#")
    #expect(root.document.urlDepth == 0)
    #expect(root.sections.isEmpty)
    #expect(root.relationships.isEmpty)
}

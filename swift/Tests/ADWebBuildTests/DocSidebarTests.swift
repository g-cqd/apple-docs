import Testing

@testable import ADContent
@testable import ADWebBuild

private func section(_ kind: String, heading: String? = nil, text: String? = nil, json: String? = nil)
    -> DocSection
{
    DocSection(sectionKind: kind, heading: heading, contentText: text, contentJson: json, sortOrder: 0)
}

@Test func relationshipContentGroups() {
    let s = section("relationships", json: #"[{"title":"Conforms To","items":[{"key":"swift/equatable","title":"Equatable"},{"title":"NoKey","identifier":"x"}]}]"#)
    let expected =
        "<h2>Relationships</h2>\n  <h3 class=\"sidebar-group-title\">Conforms To</h3>\n  <ul class=\"sidebar-list\"><li><a href=\"/docs/swift/equatable/\"><code>Equatable</code></a></li><li>NoKey</li></ul>"
    #expect(DocSidebar.buildRelationshipContent(s) == expected)
}

@Test func relationshipContentEmpty() {
    let expected = "<h2>Relationships</h2>\n  <p class=\"sidebar-hint\">See relationships section in the article.</p>"
    #expect(DocSidebar.buildRelationshipContent(section("relationships", json: "[]")) == expected)
}

@Test func pageTocSkipsAndRenders() {
    let secs = [
        section("abstract", text: "a"),
        section("declaration", json: "[{}]"),
        section("discussion", heading: "Overview", text: "text"),
        section("topics", json: #"[{"items":[{"key":"x"}]}]"#),
    ]
    let items = DocSidebar.buildPageToc(secs)
    #expect(
        items == [
            DocSidebar.TocItem(id: "declaration", label: "Declaration"),
            DocSidebar.TocItem(id: "overview", label: "Overview"),
            DocSidebar.TocItem(id: "topics", label: "Topics"),
        ])
    let html = DocSidebar.renderTocHtml(items)
    #expect(
        html
            == "<nav class=\"page-toc\"><ul><li><a href=\"#declaration\">Declaration</a></li><li><a href=\"#overview\">Overview</a></li><li><a href=\"#topics\">Topics</a></li></ul></nav>")
}

@Test func tocOmittedBelowTwoItems() {
    #expect(DocSidebar.renderTocHtml([DocSidebar.TocItem(id: "x", label: "X")]) == "")
}

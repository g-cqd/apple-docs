import ADTestKit
import Testing

@testable import ADContent

private func sec(_ kind: String, heading: String? = nil, text: String? = nil, json: String? = nil, sort: Double)
    -> DocSection
{
    DocSection(sectionKind: kind, heading: heading, contentText: text, contentJson: json, sortOrder: sort)
}

@Test func dispatchEmitsTitleThenSections() {
    let html: String = DocContentRenderer.render(
        title: "MyType",
        sections: [
            sec("abstract", json: #"[{"type":"text","text":"An abstract."}]"#, sort: 0),
            sec("discussion", heading: "Discussion", text: "Body text.", sort: 1)
        ])
    expectEqual(
        html,
        "<h1>MyType</h1>\n<p>An abstract.</p>\n<section id=\"discussion\"><h2>Discussion</h2><p>Body text.</p></section>"
    )
}

@Test func dispatchStableSortsAndSkipsEmptyAndOmitsAbsentTitle() {
    let html: String = DocContentRenderer.render(
        title: nil,
        sections: [
            sec("discussion", heading: "B", text: "second", sort: 2),
            sec("abstract", sort: 1),  // no json + no text → "" → skipped
            sec("discussion", heading: "A", text: "first", sort: 0)
        ])
    expectEqual(
        html,
        "<section id=\"a\"><h2>A</h2><p>first</p></section>\n<section id=\"b\"><h2>B</h2><p>second</p></section>")
}

@Test func dispatchEscapesTitle() {
    let html: String = DocContentRenderer.render(title: "A < B", sections: [])
    expectEqual(html, "<h1>A &lt; B</h1>")
}

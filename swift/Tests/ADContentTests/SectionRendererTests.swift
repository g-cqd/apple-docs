import ADJSONCore
import ADTestKit
import Testing

@testable import ADContent

private func section(_ kind: String, heading: String? = nil, text: String? = nil, json: String? = nil)
    -> DocSection
{
    DocSection(sectionKind: kind, heading: heading, contentText: text, contentJson: json, sortOrder: 0)
}

private func render(_ s: DocSection, knownKeys: Set<String>? = nil, highlight: CodeHighlight? = nil)
    -> String
{
    HtmlSections(knownKeys: knownKeys, highlight: highlight).renderSection(s)
}

@Test func abstractFromInlineNodesAndTextFallback() {
    let nodesForm: String = render(section("abstract", json: #"[{"type":"text","text":"An abstract."}]"#))
    expectEqual(nodesForm, "<p>An abstract.</p>")
    let textForm: String = render(section("abstract", text: "Just **bold**."))
    expectEqual(textForm, "<p>Just <strong>bold</strong>.</p>")
}

@Test func declarationLinksKnownTypes() {
    let html: String = render(
        section(
            "declaration",
            json:
                #"[{"languages":["swift"],"tokens":[{"kind":"keyword","text":"struct"},{"kind":"typeIdentifier","text":"Foo","_resolvedKey":"swiftui/foo"}]}]"#
        ),
        knownKeys: ["swiftui/foo"])
    expectEqual(
        html,
        #"<section id="declaration"><h2>Declaration</h2><pre class="decl-tokens"><code><span class="decl-keyword">struct</span> <a href="/docs/swiftui/foo/" class="code-type-link"><span class="decl-typeIdentifier">Foo</span></a></code></pre></section>"#
    )
}

@Test func parametersList() {
    let html: String = render(
        section(
            "parameters",
            json:
                #"[{"name":"value","content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"the value"}]}]}]"#
        ))
    expectEqual(
        html,
        "<section id=\"parameters\"><h2>Parameters</h2><ul><li><strong>value</strong>: <p>the value</p></li></ul></section>"
    )
}

@Test func mentionedInLinks() {
    let html: String = render(section("mentioned_in", json: #"[{"key":"swiftui/view","title":"View"}]"#))
    expectEqual(
        html,
        #"<section id="mentioned-in"><h2>Mentioned in</h2><ul><li><a href="/docs/swiftui/view/">View</a></li></ul></section>"#
    )
}

@Test func discussionSkipsDuplicateHeading() {
    let html: String = render(
        section(
            "discussion", heading: "Overview",
            json:
                #"[{"type":"heading","level":2,"text":"Overview"},{"type":"paragraph","inlineContent":[{"type":"text","text":"body"}]}]"#
        ))
    expectEqual(html, #"<section id="overview"><h2>Overview</h2><p>body</p></section>"#)
}

@Test func discussionTextFallback() {
    let html: String = render(section("discussion", heading: "Discussion", text: "Some text."))
    expectEqual(html, #"<section id="discussion"><h2>Discussion</h2><p>Some text.</p></section>"#)
}

@Test func topicsLinkSection() {
    let html: String = render(
        section("topics", json: #"[{"title":"Group A","items":[{"key":"swiftui/a","title":"A"}]}]"#))
    expectEqual(
        html,
        #"<section id="topics"><h2>Topics</h2><h3>Group A</h3><ul><li><a href="/docs/swiftui/a/"><code>A</code></a></li></ul></section>"#
    )
}

@Test func restEndpointSpans() {
    let html: String = render(
        section("rest_endpoint", json: #"[{"kind":"method","text":"GET"},{"kind":"path","text":"/v1/x"}]"#))
    expectEqual(
        html,
        #"<section id="url"><h2>URL</h2><pre class="rest-endpoint"><code><span class="rest-method">GET</span><span class="rest-path">/v1/x</span></code></pre></section>"#
    )
}

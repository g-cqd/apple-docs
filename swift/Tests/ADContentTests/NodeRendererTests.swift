import ADJSONCore
import ADTestKit
import Testing

@testable import ADContent

// Typed `let` + `expectEqual` (not `#expect(try … == …)`) to stay under the
// test target's 100ms type-check budget — the suite's house style.
private func render(_ json: String, highlight: CodeHighlight? = nil) throws -> String {
    let doc = try ADJSON.parse(json, options: .init(maxDepth: 512))
    return HtmlNodes(highlight: highlight).renderNodes(doc.root)
}

@Test func paragraphWithInlineMarks() throws {
    let html: String = try render(
        #"[{"type":"paragraph","inlineContent":[{"type":"text","text":"Hello "},{"type":"emphasis","inlineContent":[{"type":"text","text":"world"}]},{"type":"text","text":" "},{"type":"strong","inlineContent":[{"type":"text","text":"now"}]}]}]"#
    )
    expectEqual(html, "<p>Hello <em>world</em> <strong>now</strong></p>")
}

@Test func headingClampsLevelAndAddsAnchor() throws {
    let withAnchor: String = try render(#"[{"type":"heading","level":3,"text":"Overview","anchor":"overview"}]"#)
    expectEqual(withAnchor, #"<h3 id="overview">Overview</h3>"#)
    let low: String = try render(#"[{"type":"heading","level":1,"text":"A"}]"#)
    expectEqual(low, "<h2>A</h2>")
    let high: String = try render(#"[{"type":"heading","level":9,"text":"B"}]"#)
    expectEqual(high, "<h6>B</h6>")
}

@Test func codeListingFallbackAndHighlighter() throws {
    let fallback: String = try render(#"[{"type":"codeListing","syntax":"swift","code":["let x = 1","let y = 2"]}]"#)
    expectEqual(fallback, "<pre><code class=\"language-swift\">let x = 1\nlet y = 2</code></pre>")
    let hl: CodeHighlight = { code, lang in "<hl lang=\"\(lang)\">\(code)</hl>" }
    let highlighted: String = try render(#"[{"type":"codeListing","syntax":"json","code":["{}"]}]"#, highlight: hl)
    expectEqual(highlighted, "<hl lang=\"json\">{}</hl>")
}

@Test func lists() throws {
    let ul: String = try render(
        #"[{"type":"unorderedList","items":[{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"a"}]}]},{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"b"}]}]}]}]"#
    )
    expectEqual(ul, "<ul><li><p>a</p></li><li><p>b</p></li></ul>")
    let ol: String = try render(
        #"[{"type":"orderedList","items":[{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"x"}]}]}]}]"#
    )
    expectEqual(ol, "<ol><li><p>x</p></li></ol>")
}

@Test func aside() throws {
    let html: String = try render(
        #"[{"type":"aside","style":"Warning","content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"careful"}]}]}]"#
    )
    expectEqual(html, "<aside><p><strong>Warning:</strong></p><p>careful</p></aside>")
}

@Test func tableHeaderRow() throws {
    let html: String = try render(
        #"[{"type":"table","header":"row","rows":[[{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"H1"}]}]}],[{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"C1"}]}]}]]}]"#
    )
    expectEqual(
        html,
        "<table><thead><tr><th><p>H1</p></th></tr></thead><tbody><tr><td><p>C1</p></td></tr></tbody></table>")
}

@Test func linksBlockUsesResolvedKey() throws {
    let html: String = try render(
        #"[{"type":"links","items":[{"_resolvedKey":"swiftui/view","_resolvedTitle":"View"}]}]"#)
    expectEqual(html, #"<ul><li><a href="/docs/swiftui/view/">View</a></li></ul>"#)
}

@Test func referenceInlineLinksInternally() throws {
    let html: String = try render(
        #"[{"type":"paragraph","inlineContent":[{"type":"reference","_resolvedKey":"swiftui/text","_resolvedTitle":"Text"}]}]"#
    )
    expectEqual(html, #"<p><a href="/docs/swiftui/text/">Text</a></p>"#)
}

@Test func linkInlineSafetyGate() throws {
    let safe: String = try render(
        #"[{"type":"paragraph","inlineContent":[{"type":"link","destination":"https://x.com","title":"X"}]}]"#)
    expectEqual(safe, #"<p><a href="https://x.com">X</a></p>"#)
    let unsafe: String = try render(
        #"[{"type":"paragraph","inlineContent":[{"type":"link","destination":"javascript:alert(1)","title":"bad"}]}]"#)
    expectEqual(unsafe, ##"<p><a href="#">bad</a></p>"##)
}

@Test func imageRendersAltOnly() throws {
    let withAlt: String = try render(#"[{"type":"paragraph","inlineContent":[{"type":"image","alt":"A cat"}]}]"#)
    expectEqual(withAlt, "<p><span>[A cat]</span></p>")
    let noAlt: String = try render(#"[{"type":"paragraph","inlineContent":[{"type":"image"}]}]"#)
    expectEqual(noAlt, "<p><span>[Image]</span></p>")
}

@Test func escapesTextAndCode() throws {
    let text: String = try render(#"[{"type":"paragraph","inlineContent":[{"type":"text","text":"a < b & c > d"}]}]"#)
    expectEqual(text, "<p>a &lt; b &amp; c &gt; d</p>")
    let code: String = try render(#"[{"type":"paragraph","inlineContent":[{"type":"codeVoice","code":"x < y"}]}]"#)
    expectEqual(code, "<p><code>x &lt; y</code></p>")
}

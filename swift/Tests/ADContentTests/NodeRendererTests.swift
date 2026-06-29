import ADJSONCore
import Testing

@testable import ADContent

private func render(_ json: String, highlight: CodeHighlight? = nil) throws -> String {
    let doc = try ADJSON.parse(json, options: .init(maxDepth: 512))
    return HtmlNodes(highlight: highlight).renderNodes(doc.root)
}

@Test func paragraphWithInlineMarks() throws {
    let html = try render(
        #"[{"type":"paragraph","inlineContent":[{"type":"text","text":"Hello "},{"type":"emphasis","inlineContent":[{"type":"text","text":"world"}]},{"type":"text","text":" "},{"type":"strong","inlineContent":[{"type":"text","text":"now"}]}]}]"#)
    #expect(html == "<p>Hello <em>world</em> <strong>now</strong></p>")
}

@Test func headingClampsLevelAndAddsAnchor() throws {
    #expect(try render(#"[{"type":"heading","level":3,"text":"Overview","anchor":"overview"}]"#) == #"<h3 id="overview">Overview</h3>"#)
    // Level 1 clamps up to 2; level 9 clamps down to 6.
    #expect(try render(#"[{"type":"heading","level":1,"text":"A"}]"#) == "<h2>A</h2>")
    #expect(try render(#"[{"type":"heading","level":9,"text":"B"}]"#) == "<h6>B</h6>")
}

@Test func codeListingFallbackAndHighlighter() throws {
    #expect(
        try render(#"[{"type":"codeListing","syntax":"swift","code":["let x = 1","let y = 2"]}]"#)
            == "<pre><code class=\"language-swift\">let x = 1\nlet y = 2</code></pre>")
    // The highlighter seam takes over when present.
    let hl: CodeHighlight = { code, lang in "<hl lang=\"\(lang)\">\(code)</hl>" }
    #expect(
        try render(#"[{"type":"codeListing","syntax":"json","code":["{}"]}]"#, highlight: hl)
            == "<hl lang=\"json\">{}</hl>")
}

@Test func lists() throws {
    #expect(
        try render(#"[{"type":"unorderedList","items":[{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"a"}]}]},{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"b"}]}]}]}]"#)
            == "<ul><li><p>a</p></li><li><p>b</p></li></ul>")
    #expect(
        try render(#"[{"type":"orderedList","items":[{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"x"}]}]}]}]"#)
            == "<ol><li><p>x</p></li></ol>")
}

@Test func aside() throws {
    #expect(
        try render(#"[{"type":"aside","style":"Warning","content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"careful"}]}]}]"#)
            == "<aside><p><strong>Warning:</strong></p><p>careful</p></aside>")
}

@Test func tableHeaderRow() throws {
    let html = try render(
        #"[{"type":"table","header":"row","rows":[[{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"H1"}]}]}],[{"content":[{"type":"paragraph","inlineContent":[{"type":"text","text":"C1"}]}]}]]}]"#)
    #expect(
        html
            == "<table><thead><tr><th><p>H1</p></th></tr></thead><tbody><tr><td><p>C1</p></td></tr></tbody></table>")
}

@Test func linksBlockUsesResolvedKey() throws {
    #expect(
        try render(#"[{"type":"links","items":[{"_resolvedKey":"swiftui/view","_resolvedTitle":"View"}]}]"#)
            == #"<ul><li><a href="/docs/swiftui/view/">View</a></li></ul>"#)
}

@Test func referenceInlineLinksInternally() throws {
    #expect(
        try render(#"[{"type":"paragraph","inlineContent":[{"type":"reference","_resolvedKey":"swiftui/text","_resolvedTitle":"Text"}]}]"#)
            == #"<p><a href="/docs/swiftui/text/">Text</a></p>"#)
}

@Test func linkInlineSafetyGate() throws {
    #expect(
        try render(#"[{"type":"paragraph","inlineContent":[{"type":"link","destination":"https://x.com","title":"X"}]}]"#)
            == #"<p><a href="https://x.com">X</a></p>"#)
    // javascript: is not a safe href → '#'
    #expect(
        try render(#"[{"type":"paragraph","inlineContent":[{"type":"link","destination":"javascript:alert(1)","title":"bad"}]}]"#)
            == ##"<p><a href="#">bad</a></p>"##)
}

@Test func imageRendersAltOnly() throws {
    #expect(
        try render(#"[{"type":"paragraph","inlineContent":[{"type":"image","alt":"A cat"}]}]"#)
            == "<p><span>[A cat]</span></p>")
    #expect(
        try render(#"[{"type":"paragraph","inlineContent":[{"type":"image"}]}]"#)
            == "<p><span>[Image]</span></p>")
}

@Test func escapesTextAndCode() throws {
    #expect(
        try render(#"[{"type":"paragraph","inlineContent":[{"type":"text","text":"a < b & c > d"}]}]"#)
            == "<p>a &lt; b &amp; c &gt; d</p>")
    #expect(
        try render(#"[{"type":"paragraph","inlineContent":[{"type":"codeVoice","code":"x < y"}]}]"#)
            == "<p><code>x &lt; y</code></p>")
}

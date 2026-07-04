import ADJSONCore
import ADTestKit
import Testing

@testable import ADContent

private func tokens(_ json: String) throws -> JSON {
    try ADJSON.parse(json, options: .init(maxDepth: 512)).root
}

@Test func joinTokenTextsSpacing() throws {
    let semantic: String = try HtmlTokens.joinTokenTexts(
        tokens(#"[{"kind":"keyword","text":"func"},{"kind":"identifier","text":"foo"}]"#))
    expectEqual(semantic, "func foo")
    let attribute: String = try HtmlTokens.joinTokenTexts(
        tokens(#"[{"kind":"attribute","text":"@"},{"kind":"typeIdentifier","text":"MainActor"}]"#))
    expectEqual(attribute, "@MainActor")
    let skipsEmpty: String = try HtmlTokens.joinTokenTexts(
        tokens(#"[{"kind":"keyword","text":"let"},{"kind":"text","text":""},{"kind":"identifier","text":"x"}]"#))
    expectEqual(skipsEmpty, "let x")
}

@Test func declarationTokensLinkAndClasses() throws {
    let html: String = try HtmlTokens.renderDeclarationTokens(
        tokens(
            #"[{"kind":"keyword","text":"struct"},{"kind":"typeIdentifier","text":"Foo","_resolvedKey":"swiftui/foo"}]"#
        ),
        ["swiftui/foo"])
    expectEqual(
        html,
        #"<pre class="decl-tokens"><code><span class="decl-keyword">struct</span> <a href="/docs/swiftui/foo/" class="code-type-link"><span class="decl-typeIdentifier">Foo</span></a></code></pre>"#
    )
}

@Test func declarationTokensWithoutKnownKeyFallsBackToClass() throws {
    let html: String = try HtmlTokens.renderDeclarationTokens(
        tokens(#"[{"kind":"typeIdentifier","text":"Bar","_resolvedKey":"x/bar"}]"#), [])
    expectEqual(html, #"<pre class="decl-tokens"><code><span class="decl-type">Bar</span></code></pre>"#)
}

@Test func typeTokensRendering() throws {
    let linked: String = try HtmlTokens.renderTypeTokens(
        tokens(#"[{"kind":"typeIdentifier","text":"Int","_resolvedKey":"swift/int"}]"#), ["swift/int"])
    expectEqual(linked, #"<a href="/docs/swift/int/" class="code-type-link"><code>Int</code></a>"#)
    let bare: String = try HtmlTokens.renderTypeTokens(tokens(#"[{"kind":"typeIdentifier","text":"Custom"}]"#), nil)
    expectEqual(bare, "<code>Custom</code>")
    let plain: String = try HtmlTokens.renderTypeTokens(tokens(#"[{"kind":"text","text":" -> "}]"#), nil)
    expectEqual(plain, " -&gt; ")
    let empty: String = try HtmlTokens.renderTypeTokens(tokens("[]"), nil)
    expectEqual(empty, "")
}

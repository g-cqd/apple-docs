import ADTestKit
import Testing

@testable import ADContent

// MARK: - inlineMarkdown

@Test func inlineEmphasisAndCode() {
    expectEqual(
        HtmlMarkdown.inlineMarkdown("**bold** and *italic* and `code`"),
        "<strong>bold</strong> and <em>italic</em> and <code>code</code>")
    expectEqual(HtmlMarkdown.inlineMarkdown("***both***"), "<strong><em>both</em></strong>")
}

@Test func inlineUnderscoreBoundaries() {
    // Underscores inside a word are NOT emphasis.
    expectEqual(HtmlMarkdown.inlineMarkdown("foo_bar_baz"), "foo_bar_baz")
    // …but at non-alphanumeric boundaries they are.
    expectEqual(HtmlMarkdown.inlineMarkdown("_italic_"), "<em>italic</em>")
}

@Test func inlineLinksAndImages() {
    expectEqual(
        HtmlMarkdown.inlineMarkdown("[link](https://x.com)"), #"<a href="https://x.com">link</a>"#)
    // Unsafe scheme → '#'
    expectEqual(HtmlMarkdown.inlineMarkdown("[bad](javascript:x)"), ##"<a href="#">bad</a>"##)
    // Images render alt text only.
    expectEqual(HtmlMarkdown.inlineMarkdown("![alt](img.png)"), "<em>[alt]</em>")
}

@Test func inlineEscapesFirst() {
    expectEqual(HtmlMarkdown.inlineMarkdown("a < b & c"), "a &lt; b &amp; c")
}

@Test func inlineDocReference() {
    expectEqual(
        HtmlMarkdown.inlineMarkdown("<doc:Page-Name>"),
        #"<a href="/docs/swift-book/?q=Page-Name">Page Name</a>"#)
}

// MARK: - markdownToHtml (block)

@Test func blockHeadingAndParagraph() {
    expectEqual(
        HtmlMarkdown.markdownToHtml("# Heading\n\nA paragraph."),
        "<h2>Heading</h2><p>A paragraph.</p>")
}

@Test func blockLists() {
    expectEqual(HtmlMarkdown.markdownToHtml("- a\n- b"), "<ul><li>a</li><li>b</li></ul>")
    expectEqual(HtmlMarkdown.markdownToHtml("1. first\n2. second"), "<ol><li>first</li><li>second</li></ol>")
}

@Test func blockQuoteAndRule() {
    expectEqual(HtmlMarkdown.markdownToHtml("> quoted"), "<blockquote><p>quoted</p></blockquote>")
    expectEqual(HtmlMarkdown.markdownToHtml("---"), "<hr>")
}

@Test func blockFencedCode() {
    expectEqual(
        HtmlMarkdown.markdownToHtml("```swift\nlet x = 1\n```"),
        "<pre><code class=\"language-swift\">let x = 1</code></pre>")
}

@Test func blockParagraphWithInline() {
    expectEqual(HtmlMarkdown.markdownToHtml("This is **bold**."), "<p>This is <strong>bold</strong>.</p>")
    expectEqual(HtmlMarkdown.markdownToHtml(""), "")
}

// Gate for the swift-markdown-based Markdown source extractor (D3b). Verifies the
// structural normalize (title / abstract / headings / sections) and the two places a
// real CommonMark parser is correct where the retiring JS regex was not.

import Testing

@testable import ADBuilder

@Suite("MarkdownSections — swift-markdown structural extraction")
struct MarkdownSectionsTests {

    @Test("extracts h1 title, h2 headings, abstract, and discussion sections")
    func basicStructure() {
        let markdown = """
            # Feature Name

            Intro paragraph describing the feature.

            ## Motivation

            Because reasons.

            ## Detailed design

            Here is the design.
            """
        let page = MarkdownSections.parse(
            markdown, key: "swift-evolution/0001-feature",
            options: .init(sourceType: "swift-evolution", kind: "proposal"))

        #expect(page.document.title == "Feature Name")
        #expect(page.document.kind == "proposal")
        #expect(page.document.urlDepth == 1)
        #expect(page.document.headings == "Motivation Detailed design")
        #expect(page.document.abstractText == "Intro paragraph describing the feature.")

        #expect(page.sections.count == 3)
        #expect(page.sections[0].sectionKind == "abstract")
        #expect(page.sections[1].sectionKind == "discussion")
        #expect(page.sections[1].heading == "Motivation")
        #expect(page.sections[2].heading == "Detailed design")
    }

    @Test("strips YAML frontmatter and uses its title as the fallback")
    func frontmatterTitleFallback() {
        let markdown = """
            ---
            title: From Frontmatter
            ---
            ## Section

            Body.
            """
        let page = MarkdownSections.parse(markdown, key: "swift-book/intro")
        #expect(page.document.title == "From Frontmatter")
        #expect(page.sections.contains { $0.heading == "Section" })
    }

    @Test("a `## ` inside a code fence is NOT a heading (the cmark win over JS regex)")
    func codeFenceIsNotAHeading() {
        let markdown = """
            # Title

            ```
            ## not a heading
            ```

            ## Real Heading

            Body.
            """
        let page = MarkdownSections.parse(markdown, key: "k")
        #expect(page.document.headings == "Real Heading")
        #expect(page.sections.filter { $0.sectionKind == "discussion" }.count == 1)
    }
}

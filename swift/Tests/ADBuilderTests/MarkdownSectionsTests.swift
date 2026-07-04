// Gate for the swift-markdown-based Markdown source extractor (D3b). Verifies the
// structural normalize (title / abstract / headings / sections) and the two places a
// real CommonMark parser is correct where the retiring JS regex was not.
//
// Sample sources are `static let` (type-checked once, not per test body) and the
// asserts are split into focused tests to stay under the 100ms type-check budget.

import Testing

@testable import ADBuilder

@Suite("MarkdownSections — swift-markdown structural extraction")
struct MarkdownSectionsTests {
    private static let proposal = """
        # Feature Name

        Intro paragraph describing the feature.

        ## Motivation

        Because reasons.

        ## Detailed design

        Here is the design.
        """

    private static let frontmatter = """
        ---
        title: From Frontmatter
        ---
        ## Section

        Body.
        """

    private static let codeFence = """
        # Title

        ```
        ## not a heading
        ```

        ## Real Heading

        Body.
        """

    private func parsedProposal() -> NormalizedPage {
        MarkdownSections.parse(
            Self.proposal, key: "swift-evolution/0001-feature",
            options: .init(sourceType: "swift-evolution", kind: "proposal"))
    }

    @Test("document fields: h1 title, kind, urlDepth, h2 headings, first-paragraph abstract")
    func documentFields() {
        let document = parsedProposal().document
        #expect(document.title == "Feature Name")
        #expect(document.kind == "proposal")
        #expect(document.urlDepth == 1)
        #expect(document.headings == "Motivation Detailed design")
        #expect(document.abstractText == "Intro paragraph describing the feature.")
    }

    @Test("sections: abstract + one discussion per h2")
    func sectionFields() {
        let sections = parsedProposal().sections
        #expect(sections.count == 3)
        #expect(sections[0].sectionKind == "abstract")
        #expect(sections[1].heading == "Motivation")
        #expect(sections[2].heading == "Detailed design")
    }

    @Test("strips YAML frontmatter and uses its title as the fallback")
    func frontmatterTitleFallback() {
        let page = MarkdownSections.parse(Self.frontmatter, key: "swift-book/intro")
        #expect(page.document.title == "From Frontmatter")
        #expect(page.sections.contains { $0.heading == "Section" })
    }

    @Test("a `## ` inside a code fence is NOT a heading (the cmark win over JS regex)")
    func codeFenceIsNotAHeading() {
        let page = MarkdownSections.parse(Self.codeFence, key: "k")
        #expect(page.document.headings == "Real Heading")
        #expect(page.sections.filter { $0.sectionKind == "discussion" }.count == 1)
    }
}

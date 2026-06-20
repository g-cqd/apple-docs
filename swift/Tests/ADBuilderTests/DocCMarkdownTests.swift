// Gate for the DocC-markdown helpers (D3b): `<doc:Name>` reference extraction and the
// `## Topics` / `### Group` curation parser (the reusable substance the swift-book and
// other DocC-markdown adapters build on). Pure — swift-markdown AST only.

import Testing

@testable import ADBuilder

@Suite("DocCMarkdown — doc references + Topics curation")
struct DocCMarkdownTests {

    private static let book = """
        # The Swift Programming Language

        ## Topics

        ### Welcome to Swift

        - <doc:GuidedTour>
        - <doc:AboutSwift>

        ### Language Guide

        - <doc:TheBasics>

        ### Empty Group
        """

    @Test("docReferences extracts every <doc:Name> in order")
    func references() {
        let references = DocCMarkdown.docReferences(in: Self.book)
        #expect(references == ["GuidedTour", "AboutSwift", "TheBasics"])
    }

    @Test("parseTopics groups items under each ### heading, dropping empty groups")
    func topics() {
        let groups = DocCMarkdown.parseTopics(Self.book)
        #expect(groups.count == 2)
        #expect(groups[0].title == "Welcome to Swift")
        #expect(groups[0].items == ["GuidedTour", "AboutSwift"])
        #expect(groups[1].title == "Language Guide")
        #expect(groups[1].items == ["TheBasics"])
    }

    @Test("parseTopics ignores ### groups outside a ## Topics section")
    func topicsScope() {
        let markdown = """
            ## Overview

            ### Not A Topic Group

            - <doc:ShouldBeIgnored>
            """
        #expect(DocCMarkdown.parseTopics(markdown).isEmpty)
    }
}

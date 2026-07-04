// Gate for the stateful swift-book adapter (D3b): discover builds the chapter index;
// the root normalize uses it to emit a structured Topics section + child relationships;
// chapter pages get their TSPL section metadata. Mock-driven (no network).

import Testing

@testable import ADBuilder

@Suite("SwiftBookAdapter — discover + stateful root topics")
struct SwiftBookAdapterTests {
    private static let treeJSON = """
        {"tree":[\
        {"path":"TSPL.docc/The-Swift-Programming-Language.md","type":"blob","sha":"r"},\
        {"path":"TSPL.docc/GuidedTour/AboutSwift.md","type":"blob","sha":"a"},\
        {"path":"TSPL.docc/LanguageGuide/TheBasics.md","type":"blob","sha":"b"},\
        {"path":"TSPL.docc/Snippets/x.md","type":"blob","sha":"s"}]}
        """

    private static let rootMarkdown = """
        # The Swift Programming Language

        ## Topics

        ### Welcome to Swift

        - <doc:AboutSwift>

        ### Language Guide

        - <doc:TheBasics>
        """

    private func discoveredAdapter() async throws -> SwiftBookAdapter {
        let adapter = SwiftBookAdapter()
        let context = SourceContext(
            client: StubHTTPClient { _ in httpResponse(200, body: Self.treeJSON) },
            rateLimiter: instantRateLimiter())
        _ = try await adapter.discover(context)
        return adapter
    }

    @Test("discover lists TSPL.docc chapter keys and skips Snippets")
    func discover() async throws {
        let context = SourceContext(
            client: StubHTTPClient { _ in httpResponse(200, body: Self.treeJSON) },
            rateLimiter: instantRateLimiter())
        let result = try await SwiftBookAdapter().discover(context)
        #expect(
            result.keys == [
                "swift-book/The-Swift-Programming-Language",
                "swift-book/GuidedTour/AboutSwift",
                "swift-book/LanguageGuide/TheBasics"
            ])
    }

    @Test("humanize splits camelCase chapter names")
    func humanize() {
        #expect(SwiftBookAdapter.humanize("GuidedTour") == "Guided Tour")
        #expect(SwiftBookAdapter.humanize("AboutSwift") == "About Swift")
        #expect(SwiftBookAdapter.humanize("TheBasics.md") == "The Basics")
    }

    @Test("root normalize emits a Topics section + child relationships via the chapter index")
    func rootTopics() async throws {
        let adapter = try await discoveredAdapter()
        let page = try adapter.normalize(
            "swift-book/The-Swift-Programming-Language", .markdown(Self.rootMarkdown))
        #expect(page.document.kind == "collection")
        #expect(page.sections.contains { $0.sectionKind == "topics" && $0.heading == "Topics" })
        #expect(page.relationships.count == 2)
        #expect(
            page.relationships.contains {
                $0.toKey == "swift-book/GuidedTour/AboutSwift" && $0.relationType == "child"
            })
        #expect(page.relationships.contains { $0.toKey == "swift-book/LanguageGuide/TheBasics" })
    }

    @Test("chapter normalize tags the TSPL section group in sourceMetadata")
    func chapterMetadata() throws {
        let page = try SwiftBookAdapter()
            .normalize(
                "swift-book/LanguageGuide/TheBasics", .markdown("# The Basics\n\nProse."))
        #expect(page.document.kind == "book-chapter")
        #expect(page.document.sourceMetadata?.contains("Language Guide") == true)
    }
}

import AemiSearch
import AppleDocsCore
import AppleDocsStorage
import Testing

@testable import AppleDocsSearch

@Suite("Search pipeline (Bun commands/search.js parity)")
struct CorpusSearchEngineTests {
    @Test func `builds Bun FTS5 expressions for qualified, CamelCase, and explicit queries`() {
        #expect(FTSQueryBuilder.buildLexicalQuery("   ") == "\"\"")
        #expect(
            FTSQueryBuilder.buildLexicalQuery("NavigationStack")
                == "(\"navigationstack\"* OR \"navigation\" OR \"stack\")"
        )
        #expect(
            FTSQueryBuilder.buildLexicalQuery("AVAudioSession.RouteSelection")
                .contains("\"avaudiosessionrouteselection\"*")
        )
        #expect(FTSQueryBuilder.buildLexicalQuery("foo AND bar") == "foo AND bar")
        #expect(FTSQueryBuilder.buildLexicalQuery(#"say "hi""#) == #"say "hi""#)
        #expect(FTSQueryBuilder.sanitizeTrigramQuery("View.body") == "\"View.body\"")
        #expect(FTSQueryBuilder.sanitizeTrigramQuery("NavigationStack") == "NavigationStack")
    }

    @Test func `cascades exact title, FTS5 tiers, body, and post-filters like Bun`() throws {
        let store = try seedNavigationCorpus()
        defer { store.close() }

        let exact = try CorpusSearch.search(
            SearchOptions(query: "NavigationStack", deprecated: "exclude"),
            on: store.connection
        )
        #expect(exact.results.first?.path == "swiftui/navigationstack")
        #expect(exact.results.first?.matchQuality == "exact")
        #expect(!exact.results.contains { $0.record.isDeprecated })
        #expect(exact.intent?.kind == .symbol)

        let ios15 = try CorpusSearch.search(
            SearchOptions(query: "navigation", minimumVersions: ["ios": "15.0"]),
            on: store.connection
        )
        #expect(ios15.results.map(\.path) == ["swiftui/navigationview"])

        let body = try CorpusSearch.search(SearchOptions(query: "breadcrumbs"), on: store.connection)
        #expect(body.results.map(\.path) == ["swiftui/navigationstack"])
        #expect(body.results.first?.matchQuality == "body")
        #expect(body.results.first?.snippet?.contains("breadcrumbs") == true)
        #expect(body.bodyIndexAvailable)
    }

    @Test func `relaxes long queries that match nothing and ranks typos through the fuzzy tier`() throws {
        let store = try seedNavigationCorpus()
        defer { store.close() }
        let relaxed = try CorpusSearch.search(
            SearchOptions(query: "how should I use the NavigationStack thing zzqx"),
            on: store.connection
        )
        #expect(relaxed.relaxationTier == "pruned-or")
        #expect(relaxed.results.first?.path == "swiftui/navigationstack")

        // `NavigationStak` FTS-matches NavigationView on the CamelCase sub-word `navigation`; with fewer than 5
        // hits, the fuzzy tier adds NavigationStack (edit distance 1), ranked below the lexical match (as in Bun).
        let typo = try CorpusSearch.search(SearchOptions(query: "NavigationStak"), on: store.connection)
        #expect(typo.results.map(\.path) == ["swiftui/navigationview", "swiftui/navigationstack"])
        #expect(typo.results.last?.matchQuality == "fuzzy")
        #expect(typo.results.last?.distance == 1)
    }

    @Test func `detects Bun intents and sorts like JavaScriptCore`() {
        // Expected values produced by Bun's `detectIntent` (src/search/intent.js).
        let expected: [(String, SearchIntent.Kind, Double)] = [
            ("NavigationStack", .symbol, 0.9), ("View.body", .symbol, 0.9), ("how to present a sheet", .howto, 0.8),
            ("app crashes on launch", .general, 0.5), ("app crash on launch", .error, 0.8),
            ("what is a scene", .concept, 0.7), ("wwdc 2023 sessions", .wwdc, 0.8), ("layout", .general, 0.5),
            ("Foo::bar", .symbol, 0.9), ("URLSession", .symbol, 0.7), ("difference  between x", .concept, 0.7),
            ("vs. other", .concept, 0.7), ("UIView", .symbol, 0.7)
        ]
        for (query, kind, confidence) in expected {
            #expect(SearchIntent.detect(query) == SearchIntent(kind: kind, confidence: confidence), "\(query)")
        }
        // A comparator that is not a strict weak ordering (Bun's 0.001 score tolerance) still sorts stably.
        let sorted = JSArraySort.sorted([3.0005, 3.0, 2.0, 3.0009]) { abs($1 - $0) > 0.001 ? $1 - $0 : 0 }
        #expect(sorted == [3.0005, 3.0, 3.0009, 2.0])
    }

    /// libFuzzer crash-e6acfcd0 / dafee046 (`FuzzFTSQuery`): explicit or hostile syntax never fails the search.
    @Test func `malformed explicit FTS5 syntax falls back instead of failing`() throws {
        let inputs = [
            #"Naviga;ignSta path" OR NOT x* (y)"#, "\u{0742}\u{FFFD}v\u{FFFD}J", "\u{FFFD}if:\":\"\"\u{07FD}::",
            "a \"\u{0301}b"
        ]
        for input in inputs {
            let trigram = FTSQueryBuilder.sanitizeTrigramQuery(input)
            #expect(trigram.utf8.count(where: { $0 == UInt8(ascii: "\"") }) % 2 == 0, "\(trigram)")
        }
        let store = try seedNavigationCorpus()
        defer { store.close() }
        for query in [#"NavigationStack "path OR x*"#, "NavigationStack AND (", "NOT NOT", #"""""#] + inputs {
            _ = try CorpusSearch.search(SearchOptions(query: query), on: store.connection)
        }
        // Rejected explicit syntax retries as one quoted prefix phrase (Bun `runFts` fallback).
        let phrase = try CorpusSearch.search(SearchOptions(query: #""NavigationStack"#), on: store.connection)
        #expect(phrase.results.first?.path == "swiftui/navigationstack")
    }

    @Test func `indexes symbols in AemiSearch SymbolMemoryIndex with typo expansion and snapshot round-trip`() throws {
        let index = SymbolMemoryIndex()
        index.add(
            DocumentRecord(
                key: try DocumentKey("swiftui/navigationstack"),
                title: "NavigationStack",
                framework: "swiftui",
                abstractText: "Stack-based navigation container."
            )
        )
        index.add(
            DocumentRecord(
                key: try DocumentKey("uikit/uinavigationcontroller"),
                title: "UINavigationController",
                framework: "uikit",
                abstractText: "Container view controller for hierarchical content."
            )
        )

        let typoHits = index.search("navigaton", framework: "swiftui", limit: 5)
        #expect(typoHits.first?.key.rawValue == "swiftui/navigationstack")

        let restored = try SymbolMemoryIndex(serialized: index.serialized())
        #expect(restored.count == 2)
        let restoredHits = restored.search("NavigationController", framework: "uikit", limit: 5)
        #expect(restoredHits.first?.key.rawValue == "uikit/uinavigationcontroller")
    }

    private func seedNavigationCorpus() throws -> CorpusStore {
        let store = try CorpusStore(path: ":memory:")
        let navStackID = try store.upsertDocument(
            DocumentRecord(
                key: try DocumentKey("swiftui/navigationstack"),
                title: "NavigationStack",
                kind: "struct",
                role: "symbol",
                roleHeading: "Structure",
                framework: "swiftui",
                language: "swift",
                usr: "s:7SwiftUI15NavigationStackV",
                abstractText: "Displays a root view and enables pushing views onto a stack.",
                availability: PlatformAvailability(ios: "16.0", macos: "13.0")
            )
        )
        try store.replaceSections(
            forDocumentID: navStackID,
            sections: [
                DocumentSectionRecord(
                    sectionKind: "discussion",
                    heading: "Deep linking",
                    contentText: "Manage programmatic breadcrumbs with NavigationPath bindings.",
                    sortOrder: 0
                )
            ]
        )
        try store.upsertDocument(
            DocumentRecord(
                key: try DocumentKey("swiftui/navigationview"),
                title: "NavigationView",
                kind: "struct",
                role: "symbol",
                roleHeading: "Structure",
                framework: "swiftui",
                language: "swift",
                abstractText: "Legacy split navigation view.",
                availability: PlatformAvailability(ios: "13.0", macos: "10.15"),
                isDeprecated: true
            )
        )
        return store
    }
}

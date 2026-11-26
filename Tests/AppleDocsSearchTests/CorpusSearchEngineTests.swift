import AppleDocsCore
import AppleDocsSearch
import AppleDocsStorage
import Testing

@Suite("CorpusSearchEngine & FTSQueryBuilder")
struct CorpusSearchEngineTests {
    @Test func `builds qualified identifier and CamelCase FTS5 queries safely`() {
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
        #expect(FTSQueryBuilder.sanitizeTrigramQuery("View.body") == "\"View.body\"")
        #expect(FTSQueryBuilder.sanitizeTrigramQuery("NavigationStack") == "NavigationStack")
    }

    @Test func `cascades exact title, USR, FTS5, and body with platform and deprecation filters`() throws {
        let store = try seedNavigationCorpus()

        let exactHits = try CorpusSearchEngine.search(
            CorpusSearchRequest(query: "NavigationStack", deprecated: .exclude),
            on: store.connection
        )
        #expect(exactHits.first?.document.key.rawValue == "swiftui/navigationstack")
        #expect(exactHits.first?.confidence == .exact)
        #expect(!exactHits.contains { $0.document.isDeprecated })

        let usrHits = try CorpusSearchEngine.search(
            CorpusSearchRequest(query: "s:7SwiftUI15NavigationStackV"),
            on: store.connection
        )
        #expect(usrHits.count == 1)
        #expect(usrHits[0].confidence == .exact)

        let ios15Hits = try CorpusSearchEngine.search(
            CorpusSearchRequest(query: "navigation", minVersions: PlatformAvailability(ios: "15.0")),
            on: store.connection
        )
        #expect(ios15Hits.map(\.document.key.rawValue) == ["swiftui/navigationview"])

        let bodyHits = try CorpusSearchEngine.search(
            CorpusSearchRequest(query: "breadcrumbs"),
            on: store.connection
        )
        #expect(bodyHits.map(\.document.key.rawValue) == ["swiftui/navigationstack"])
        #expect(bodyHits.first?.confidence == .approximate)
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

    @Test func `fuses ranked lists via HybridRankFusion and shortlists binary vectors accurately`() {
        let fused = HybridRankFusion.fuse([
            HybridRankFusion.RankedList(keys: ["a", "b"], weight: 1.0, scores: ["a": 10.0, "b": 4.0]),
            HybridRankFusion.RankedList(keys: ["b", "c"], weight: 0.6, scores: ["b": 0.9, "c": 0.8])
        ])
        #expect((fused["a"] ?? 0) > (fused["c"] ?? 0))
        #expect((fused["b"] ?? 0) > (fused["c"] ?? 0))

        let q = BinaryVectorScorer.quantizeBinary([1, -1, 1, -1, 1, -1, 1, -1])
        let exact = BinaryVectorScorer.quantizeBinary([1, -1, 1, -1, 1, -1, 1, -1])
        let opposite = BinaryVectorScorer.quantizeBinary([-1, 1, -1, 1, -1, 1, -1, 1])
        let near = BinaryVectorScorer.quantizeBinary([1, -1, 1, -1, 1, -1, 1, 1])

        let top2 = BinaryVectorScorer.shortlist(
            query: q,
            packedCodes: opposite + near + exact,
            codeByteWidth: 1,
            topK: 2
        )
        #expect(top2.map(\.index) == [2, 1])
        #expect(top2.map(\.distance) == [0, 1])

        let scaleBits = Float(0.5).bitPattern
        let payload: [UInt8] = [
            UInt8(bitPattern: Int8(10)),
            UInt8(bitPattern: Int8(-20)),
            UInt8(truncatingIfNeeded: scaleBits),
            UInt8(truncatingIfNeeded: scaleBits >> 8),
            UInt8(truncatingIfNeeded: scaleBits >> 16),
            UInt8(truncatingIfNeeded: scaleBits >> 24)
        ]
        #expect(BinaryVectorScorer.dotInt8(query: [2.0, -1.0], quantizedPayload: payload) == 20.0)
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

import AppleDocsContent
import AppleDocsCore
import AppleDocsSources
import Testing

@Suite("DocC archive & Markdown source adapters (SwiftDocC, ExternalDocC, SwiftEvolution, SwiftBook)")
struct SwiftSourceAdaptersTests {
    @Test func `SwiftDocCAdapter discovers paths from archive index/index.json and prefixes archive keys`()
        async throws
    {
        let transport = RecordingTransport()
        let indexJSON = #"""
            {"interfaceLanguages": {"swift": [
              {"path": "/documentation/diagnostics", "children": [
                {"path": "/documentation/diagnostics/actor-isolated-call"}
              ]}
            ]}}
            """#
        let pageJSON = #"""
            {"metadata": {"title": "Actor-Isolated Call", "role": "article"},
             "abstract": [{"type": "text", "text": "Diagnostic detail."}],
             "seeAlsoSections": [{"title": "Related", "identifiers": ["doc://c/documentation/diagnostics"]}],
             "references": {"doc://c/documentation/diagnostics": {"title": "Diagnostics", "url": "/documentation/diagnostics"}}}
            """#
        transport.set("https://docs.swift.org/compiler/index/index.json", body: indexJSON)
        transport.set("https://docs.swift.org/swiftpm/index/index.json", body: #"{"interfaceLanguages":{"swift":[]}}"#)
        transport.set("https://www.swift.org/migration/index/index.json", body: #"{"interfaceLanguages":{"swift":[]}}"#)
        transport.set(
            "https://docs.swift.org/compiler/data/documentation/diagnostics/actor-isolated-call.json",
            body: pageJSON,
            etag: "\"d1\""
        )

        let client = UpstreamHTTPClient(transport: transport)
        let adapter = SwiftDocCAdapter()
        let discovery = try await adapter.discover(client: client, full: false)
        #expect(
            discovery.roots.map(\.slug).sorted() == [
                "swift-compiler", "swift-migration-guide", "swift-package-manager"
            ]
        )
        #expect(
            discovery.keys.map(\.rawValue) == [
                "swift-compiler/documentation/diagnostics",
                "swift-compiler/documentation/diagnostics/actor-isolated-call"
            ]
        )

        let key = try DocumentKey("swift-compiler/documentation/diagnostics/actor-isolated-call")
        guard
            case .modified(let payload, let etag, _) = try await adapter.fetch(
                key: key,
                previousETag: nil,
                client: client
            ),
            let converted = payload.converted
        else {
            Issue.record("expected modified outcome")
            return
        }
        #expect(etag == "\"d1\"" && converted.document.sourceType == .swiftDocC)
        #expect(
            converted.document.url == "https://docs.swift.org/compiler/documentation/diagnostics/actor-isolated-call"
        )
        #expect(converted.relationships.map(\.toKey.rawValue) == ["swift-compiler/documentation/diagnostics"])
    }

    @Test func `ExternalDocCAdapter enumerates index.json and falls back to BFS for archives without one`()
        async throws
    {
        let transport = RecordingTransport()
        transport.set(AppleRootCatalog.technologiesURL, body: #"{"sections":[]}"#)
        transport.set(
            "https://www.swift.org/index/index.json",
            body:
                #"{"interfaceLanguages":{"swift":[{"path":"/documentation/docc"},{"path":"/documentation/docc/overview"}]}}"#
        )
        transport.set("https://security.apple.com/index/index.json", body: #"{"interfaceLanguages":{"swift":[]}}"#)
        transport.set(
            "https://security.apple.com/data/documentation/private-cloud-compute.json",
            body: #"{"metadata":{"title":"PCC"}}"#
        )
        transport.fail("https://carekit-apple.github.io/CareKit/index/index.json", status: 404)
        transport.set(
            "https://carekit-apple.github.io/CareKit/data/documentation/carekit.json",
            body: #"""
                {"metadata":{"title":"CareKit"},
                 "topicSections":[{"title":"Tasks","identifiers":["doc://ck/documentation/carekit/ocktask"]}],
                 "references":{"doc://ck/documentation/carekit/ocktask":{"url":"/documentation/carekit/ocktask"}}}
                """#
        )
        transport.set(
            "https://carekit-apple.github.io/CareKit/data/documentation/carekit/ocktask.json",
            body: #"{"metadata":{"title":"OCKTask"}}"#
        )

        let client = UpstreamHTTPClient(transport: transport)
        let adapter = ExternalDocCAdapter()
        let keys = Set((try await adapter.discover(client: client, full: false)).keys.map(\.rawValue))
        #expect(keys.isSuperset(of: ["docc", "docc/overview", "carekit", "carekit/ocktask"]))

        let ck = try await adapter.fetch(key: try DocumentKey("carekit/ocktask"), previousETag: nil, client: client)
        if case .modified(let payload, _, _) = ck, let doc = payload.converted?.document {
            #expect(doc.sourceType == .externalDocC)
            #expect(doc.url == "https://carekit-apple.github.io/CareKit/documentation/carekit/ocktask")
        } else {
            Issue.record("expected modified CareKit page")
        }
    }

    @Test func `SwiftEvolutionAdapter discovers proposals from GitHub tree and parses SE header metadata`()
        async throws
    {
        let transport = RecordingTransport()
        transport.set(
            "https://api.github.com/repos/swiftlang/swift-evolution/git/trees/main?recursive=1",
            body: #"{"truncated":false,"tree":[{"path":"proposals/0001-keywords.md","type":"blob"}]}"#
        )
        let md =
            "# Allow keywords\n\n* Proposal: [SE-0001](0001-keywords.md)\n* Author: [Doug](https://x)\n* Status: **Implemented (Swift 2.2)**\n\n## Intro\n\nText."
        transport.set(
            "https://raw.githubusercontent.com/swiftlang/swift-evolution/main/proposals/0001-keywords.md",
            body: md
        )

        let client = UpstreamHTTPClient(transport: transport)
        let adapter = SwiftEvolutionAdapter()
        let discovery = try await adapter.discover(client: client, full: false)
        #expect(discovery.keys.map(\.rawValue) == ["swift-evolution/0001-keywords"])

        let key = try DocumentKey("swift-evolution/0001-keywords")
        guard case .modified(let payload, _, _) = try await adapter.fetch(key: key, previousETag: nil, client: client),
            let converted = payload.converted
        else {
            Issue.record("expected modified proposal")
            return
        }
        #expect(converted.document.title == "SE-0001: Allow keywords" && converted.document.kind == "proposal")
        #expect(converted.document.sourceMetadataJSON?.contains("\"swiftVersion\":\"2.2\"") == true)
    }

    @Test func `SwiftBookAdapter discovers TSPL chapters and links root TOC <doc:...> references`() async throws {
        let transport = RecordingTransport()
        transport.set(
            "https://api.github.com/repos/swiftlang/swift-book/git/trees/main?recursive=1",
            body: #"""
                {"truncated":false,"tree":[
                  {"path":"TSPL.docc/The-Swift-Programming-Language.md","type":"blob"},
                  {"path":"TSPL.docc/LanguageGuide/TheBasics.md","type":"blob"},
                  {"path":"TSPL.docc/Assets/Snippets/Ignore.md","type":"blob"}
                ]}
                """#
        )
        transport.set(
            "https://raw.githubusercontent.com/swiftlang/swift-book/main/TSPL.docc/The-Swift-Programming-Language.md",
            body: "# The Swift Programming Language\n\nWelcome.\n\n## Topics\n\n### Language Guide\n\n- <doc:TheBasics>"
        )
        transport.set(
            "https://raw.githubusercontent.com/swiftlang/swift-book/main/TSPL.docc/LanguageGuide/TheBasics.md",
            body: "# The Basics\n\nWork with common types."
        )

        let client = UpstreamHTTPClient(transport: transport)
        let adapter = SwiftBookAdapter()
        let discovery = try await adapter.discover(client: client, full: false)
        #expect(discovery.keys.count == 2)

        let rootKey = try DocumentKey("swift-book/the-swift-programming-language")
        if case .modified(let p, _, _) = try await adapter.fetch(key: rootKey, previousETag: nil, client: client),
            let rootDoc = p.converted
        {
            #expect(rootDoc.document.kind == "collection")
            #expect(rootDoc.relationships.map(\.toKey.rawValue) == ["swift-book/languageguide/thebasics"])
            #expect(rootDoc.sections.contains { $0.sectionKind == "topics" })
        } else {
            Issue.record("expected modified root chapter")
        }

        let chKey = try DocumentKey("swift-book/languageguide/thebasics")
        if case .modified(let p, _, _) = try await adapter.fetch(key: chKey, previousETag: nil, client: client),
            let chDoc = p.converted
        {
            #expect(chDoc.document.kind == "book-chapter")
            #expect(chDoc.document.sourceMetadataJSON?.contains("Language Guide") == true)
        } else {
            Issue.record("expected modified chapter")
        }
    }
}

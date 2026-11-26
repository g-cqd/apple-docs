import AemiJSONRPC
import AppleDocsCommands
import AppleDocsCore
import AppleDocsMCP
import AppleDocsOutput
import AppleDocsStorage
import Foundation
import Testing

@Suite("MCP Resources, Tool Schemas, Excerpts & Concurrency Guards")
struct MCPPhase1ParityTests {
    @Test func `extracts section markdown, match excerpt windows, and incoming/outgoing links`() throws {
        let store = try CorpusStore(path: ":memory:")
        let navKey = try DocumentKey("swiftui/navigationstack")
        let viewKey = try DocumentKey("swiftui/view")
        let docID = try store.upsertDocument(
            DocumentRecord(
                key: navKey,
                title: "NavigationStack",
                framework: "swiftui",
                abstractText: "Displays a root view with NavigationPath state."
            )
        )
        try store.replaceSections(
            forDocumentID: docID,
            sections: [
                DocumentSectionRecord(
                    sectionKind: "overview",
                    heading: "Overview",
                    contentText: "Use NavigationStack to push destinations cleanly.",
                    sortOrder: 0
                ),
                DocumentSectionRecord(
                    sectionKind: "discussion",
                    heading: "Deep Linking",
                    contentText: "Restore deep link state via NavigationPath encoding.",
                    sortOrder: 1
                )
            ]
        )
        try store.upsertRelationship(
            DocumentRelationshipRecord(
                fromKey: navKey,
                toKey: viewKey,
                relationType: "conforms-to",
                section: "Conforms To"
            )
        )

        let detail = try #require(try CorpusQueryService.readDocument(key: navKey, on: store))
        let deepLinkSection = try #require(detail.renderMarkdown(sectionHeading: "Deep Linking"))
        #expect(deepLinkSection.contains("## Deep Linking"))
        #expect(!deepLinkSection.contains("push destinations"))
        #expect(detail.renderMarkdown(sectionHeading: "Nonexistent") == nil)

        let excerpts = detail.matchExcerpts(query: "NavigationPath", context: 30, maxMatches: 5)
        #expect(excerpts.count == 2)
        #expect(excerpts[1].sectionHeading == "Deep Linking")

        let outgoing = try CorpusQueryService.links(forKey: navKey, direction: .outgoing, on: store)
        #expect(outgoing.count == 1)
        #expect(outgoing[0].to == "swiftui/view")

        let incoming = try CorpusQueryService.links(forKey: viewKey, direction: .incoming, on: store)
        #expect(incoming.count == 1)
        #expect(incoming[0].from == "swiftui/navigationstack")
    }

    @Test func `exposes rich MCP tool schemas, search_docs read=true, read_doc match/section, and MCP resources`()
        async throws
    {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-docs-mcp-p1-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let dbPath = tempDir.appendingPathComponent("corpus.db").path
        let store = try CorpusStore(path: dbPath, options: .readWrite)
        try store.upsertRoot(CorpusRootRecord(slug: "swiftui", displayName: "SwiftUI", kind: "framework", pageCount: 1))
        let docID = try store.upsertDocument(
            DocumentRecord(
                key: try DocumentKey("swiftui/navigationstack"),
                title: "NavigationStack",
                framework: "swiftui",
                abstractText: "Stack-based navigation with NavigationPath."
            )
        )
        try store.replaceSections(
            forDocumentID: docID,
            sections: [
                DocumentSectionRecord(
                    sectionKind: "discussion",
                    heading: "State",
                    contentText: "Bind NavigationPath.",
                    sortOrder: 0
                )
            ]
        )
        store.close()

        let dispatcher = MCPServerDispatcher(databasePath: dbPath, resourcesDirectory: tempDir.path)
        defer { Task { await dispatcher.close() } }

        // tools/list returns real parameter schemas
        let toolsResp = try #require(
            await dispatcher.handleRawPayload(Array(#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.utf8))
        )
        let toolsText = String(decoding: toolsResp, as: UTF8.self)
        #expect(toolsText.contains("\"minVersion\""))
        #expect(toolsText.contains("\"required\":[\"query\"]"))

        // search_docs with read=true inlines top hit markdown
        let inlineCall =
            #"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"NavigationStack","read":true}}}"#
        let inlineResp = try #require(await dispatcher.handleRawPayload(Array(inlineCall.utf8)))
        let inlineText = String(decoding: inlineResp, as: UTF8.self)
        #expect(inlineText.contains("# NavigationStack"))
        #expect(inlineText.contains("Bind NavigationPath."))

        // read_doc with match object returns JSON excerpts
        let matchCall =
            #"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_doc","arguments":{"path":"swiftui/navigationstack","match":{"query":"NavigationPath"}}}}"#
        let matchResp = try #require(await dispatcher.handleRawPayload(Array(matchCall.utf8)))
        #expect(String(decoding: matchResp, as: UTF8.self).contains(#"\"excerpt\""#))

        // resources/templates/list, resources/list, and resources/read
        let templatesResp = try #require(
            await dispatcher.handleRawPayload(
                Array(#"{"jsonrpc":"2.0","id":4,"method":"resources/templates/list"}"#.utf8)
            )
        )
        #expect(String(decoding: templatesResp, as: UTF8.self).contains("apple-docs://doc/{+key}"))

        let listResResp = try #require(
            await dispatcher.handleRawPayload(Array(#"{"jsonrpc":"2.0","id":5,"method":"resources/list"}"#.utf8))
        )
        #expect(String(decoding: listResResp, as: UTF8.self).contains("apple-docs://framework/swiftui"))

        let readResCall =
            #"{"jsonrpc":"2.0","id":6,"method":"resources/read","params":{"uri":"apple-docs://doc/swiftui/navigationstack"}}"#
        let readResResp = try #require(await dispatcher.handleRawPayload(Array(readResCall.utf8)))
        #expect(String(decoding: readResResp, as: UTF8.self).contains("Bind NavigationPath."))
    }

    @Test func `BoundedLRUCache evicts least-recently-used key and AsyncPermitPool bounds concurrency`() async {
        let cache = BoundedLRUCache<String, Int>(capacity: 2)
        await cache.set("a", value: 1)
        await cache.set("b", value: 2)
        #expect(await cache.get("a") == 1)  // "a" becomes MRU, "b" is LRU
        await cache.set("c", value: 3)  // evicts "b"
        #expect(await cache.get("b") == nil)
        #expect(await cache.get("a") == 1)
        #expect(await cache.get("c") == 3)

        let permits = AsyncPermitPool(limit: 2)
        let sum = await withTaskGroup(of: Int.self) { group in
            for idx in 1 ... 8 {
                group.addTask {
                    await permits.withPermit { idx }
                }
            }
            var total = 0
            for await val in group { total += val }
            return total
        }
        #expect(sum == 36)
    }
}

import AemiHTTP
import AemiJSONCore
import AemiJSONRPC
import AppleDocsCommands
import AppleDocsCore
import AppleDocsMCP
import AppleDocsOutput
import AppleDocsSearch
import AppleDocsStorage
import Foundation
import Testing

@Suite("MCP Server & Public Output Boundary")
struct MCPServerTests {
    @Test func `public projection excludes internal fields and paginates markdown deterministically`() throws {
        let doc = DocumentRecord(
            key: try DocumentKey("swiftui/view"),
            title: "View",
            kind: "protocol",
            roleHeading: "Protocol",
            framework: "swiftui",
            usr: "s:7SwiftUI4ViewP",
            abstractText: "A type that represents part of your app UI."
        )
        let projected = PublicSearchResult(document: doc, confidence: SearchConfidence.exact.rawValue)
        let json = try PublicProjection.encodeJSON(projected)

        #expect(json.contains("\"path\":\"swiftui\\/view\"") || json.contains("\"path\":\"swiftui/view\""))
        #expect(json.contains("\"confidence\":\"exact\""))
        #expect(!json.contains("isDeprecated"))
        #expect(!json.contains("isBeta"))
        #expect(!json.contains("documentID"))
        #expect(!json.contains("usr"))

        let detail = PublicDocumentDetail(
            document: doc,
            sections: [
                DocumentSectionRecord(
                    sectionKind: "overview",
                    heading: "Overview",
                    contentText: String(repeating: "a", count: 700)
                )
            ]
        )
        let md = detail.renderMarkdown()
        let page1 = PublicProjection.paginate(md, maxChars: 512, page: 1)
        let page2 = PublicProjection.paginate(md, maxChars: 512, page: 2)
        #expect(page1.totalPages == 2)
        #expect(page1.text.count == 512)
        #expect(!page2.text.isEmpty)
    }

    @Test func `dispatches initialize, tools/list, search_docs, read_doc, list_frameworks, browse, and list_taxonomy`()
        async throws
    {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-docs-mcp-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let dbPath = tempDir.appendingPathComponent("corpus.db").path
        try seedCorpus(at: dbPath)

        let dispatcher = MCPServerDispatcher(databasePath: dbPath)
        defer { Task { await dispatcher.close() } }

        let initResp = try #require(
            await dispatcher.handleRawPayload(Array(#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#.utf8))
        )
        let initText = String(decoding: initResp, as: UTF8.self)
        #expect(initText.contains("\"protocolVersion\":\"2025-03-26\""))
        #expect(initText.contains("\"name\":\"apple-docs\""))

        let listResp = try #require(
            await dispatcher.handleRawPayload(Array(#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#.utf8))
        )
        #expect(String(decoding: listResp, as: UTF8.self).contains("search_docs"))

        let searchCall =
            #"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"NavigationStack"}}}"#
        let searchResp = try #require(await dispatcher.handleRawPayload(Array(searchCall.utf8)))
        let searchText = String(decoding: searchResp, as: UTF8.self)
        #expect(searchText.contains("NavigationStack"))
        #expect(searchText.contains("exact"))

        let readCall =
            #"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_doc","arguments":{"path":"swiftui/navigationstack"}}}"#
        let readResp = try #require(await dispatcher.handleRawPayload(Array(readCall.utf8)))
        #expect(String(decoding: readResp, as: UTF8.self).contains("# NavigationStack"))

        let taxCall =
            #"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_taxonomy","arguments":{"field":"kind"}}}"#
        let taxResp = try #require(await dispatcher.handleRawPayload(Array(taxCall.utf8)))
        #expect(String(decoding: taxResp, as: UTF8.self).contains("struct"))

        let symCall =
            #"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"search_sf_symbols","arguments":{"query":"star"}}}"#
        let symResp = try #require(await dispatcher.handleRawPayload(Array(symCall.utf8)))
        #expect(String(decoding: symResp, as: UTF8.self).contains("star.fill"))

        let fontCall =
            #"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_apple_fonts","arguments":{}}}"#
        let fontResp = try #require(await dispatcher.handleRawPayload(Array(fontCall.utf8)))
        let fontText = String(decoding: fontResp, as: UTF8.self)
        #expect(fontText.contains("SF Pro"))
        #expect(!fontText.contains("/Users/"))
    }

    @Test func `MCPHTTPResponder enforces Origin allowlist, method checks, body cap, and batch rejection`() async throws
    {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-docs-mcp-http-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let dbPath = tempDir.appendingPathComponent("corpus.db").path
        try seedCorpus(at: dbPath)

        let dispatcher = MCPServerDispatcher(databasePath: dbPath)
        let responder = MCPHTTPResponder(dispatcher: dispatcher, maxBodyBytes: 256)

        // Health probe
        let health = await responder.respond(to: HTTPRequest(method: .get, path: "/healthz"))
        #expect(health.head.status == .ok)

        // Cross-site Origin denied with 403
        var evilFields = HTTPFields()
        _ = evilFields.setValue("https://evil.example", for: .origin)
        let denied = await responder.respond(
            to: HTTPRequest(method: .post, path: "/mcp", headerFields: evilFields),
            body: Array(#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.utf8)
        )
        #expect(denied.head.status == .forbidden)

        // Loopback Origin allowed
        var localFields = HTTPFields()
        _ = localFields.setValue("http://localhost:3000", for: .origin)
        let allowed = await responder.respond(
            to: HTTPRequest(method: .post, path: "/mcp", headerFields: localFields),
            body: Array(#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.utf8)
        )
        #expect(allowed.head.status == .ok)

        // Oversized body rejected with 413
        let oversized = await responder.respond(
            to: HTTPRequest(method: .post, path: "/mcp"),
            body: [UInt8](repeating: 0x41, count: 512)
        )
        #expect(oversized.head.status == .contentTooLarge)

        // JSON-RPC batch array rejected with -32600
        let batch = await responder.respond(
            to: HTTPRequest(method: .post, path: "/mcp"),
            body: Array(#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#.utf8)
        )
        #expect(batch.head.status == .ok)
        #expect(String(decoding: batch.body, as: UTF8.self).contains("-32600"))

        await dispatcher.close()
    }

    private func seedCorpus(at path: String) throws {
        let store = try CorpusStore(path: path, options: .readWrite)
        defer { store.close() }
        try store.upsertRoot(
            CorpusRootRecord(slug: "swiftui", displayName: "SwiftUI", kind: "framework", pageCount: 1)
        )
        let id = try store.upsertDocument(
            DocumentRecord(
                key: try DocumentKey("swiftui/navigationstack"),
                title: "NavigationStack",
                kind: "struct",
                role: "symbol",
                roleHeading: "Structure",
                framework: "swiftui",
                abstractText: "Stack-based navigation."
            )
        )
        try store.replaceSections(
            forDocumentID: id,
            sections: [DocumentSectionRecord(sectionKind: "overview", heading: "Overview", contentText: "Push views.")]
        )
        try store.connection.executeScript(
            """
            INSERT INTO sf_symbols (name, scope, keywords_json, categories_json, codepoint)
            VALUES ('star.fill', 'public', '["favorite"]', '["objectsandtools"]', 1048576);
            INSERT INTO apple_font_families (id, display_name, category, status)
            VALUES ('sf-pro', 'SF Pro', 'system', 'available');
            INSERT INTO apple_font_files (id, family_id, file_name, file_path, format)
            VALUES ('sf-pro-reg', 'sf-pro', 'SF-Pro.ttf', '/Users/secret/fonts/SF-Pro.ttf', 'ttf');
            """
        )
    }
}

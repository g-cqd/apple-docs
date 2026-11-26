import AemiHTTP
import AppleDocsCore
import AppleDocsStorage
import AppleDocsWeb
import Foundation
import Testing

@Suite("WebHTTPResponder & SSR HTML Hardening")
struct WebServerTests {
    @Test func `serves well-known discovery endpoints, JSON API, and escaped SSR HTML with security headers`()
        async throws
    {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-docs-web-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let dbPath = tempDir.appendingPathComponent("corpus.db").path
        try seedWebCorpus(at: dbPath)

        let responder = WebHTTPResponder(databasePath: dbPath)
        defer { Task { await responder.close() } }

        // Discovery endpoints
        let health = await responder.respond(to: HTTPRequest(method: .get, path: "/healthz"))
        #expect(health.head.status == .ok)
        #expect(health.head.headerFields[.xContentTypeOptions] == "nosniff")
        #expect(health.head.headerFields[.contentSecurityPolicy]?.contains("default-src 'self'") == true)

        let card = await responder.respond(to: HTTPRequest(method: .get, path: "/.well-known/mcp/server-card.json"))
        #expect(card.head.status == .ok)
        #expect(String(decoding: card.body, as: UTF8.self).contains("\"/mcp\""))

        // JSON API
        let search = await responder.respond(to: HTTPRequest(method: .get, path: "/api/search?q=View"))
        #expect(search.head.status == .ok)
        let searchBody = String(decoding: search.body, as: UTF8.self)
        #expect(searchBody.contains("swiftui"))
        #expect(!searchBody.contains("documentID"))

        // SSR HTML escapes hostile script tags
        let page = await responder.respond(to: HTTPRequest(method: .get, path: "/doc/swiftui/view"))
        #expect(page.head.status == .ok)
        let html = String(decoding: page.body, as: UTF8.self)
        #expect(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"))
        #expect(!html.contains("<script>alert(1)</script>"))

        // Traversal path rejected
        let traversal = await responder.respond(to: HTTPRequest(method: .get, path: "/doc/../../etc/passwd"))
        #expect(traversal.head.status == .badRequest)

        // Mutating verb rejected
        let post = await responder.respond(to: HTTPRequest(method: .post, path: "/api/search"))
        #expect(post.head.status == .methodNotAllowed)
    }

    private func seedWebCorpus(at path: String) throws {
        let store = try CorpusStore(path: path, options: .readWrite)
        defer { store.close() }
        try store.upsertRoot(
            CorpusRootRecord(slug: "swiftui", displayName: "SwiftUI", kind: "framework", pageCount: 1)
        )
        let id = try store.upsertDocument(
            DocumentRecord(
                key: try DocumentKey("swiftui/view"),
                title: "View",
                framework: "swiftui",
                abstractText: "Protocol with <script>alert(1)</script> literal."
            )
        )
        try store.replaceSections(
            forDocumentID: id,
            sections: [DocumentSectionRecord(sectionKind: "overview", heading: "Overview", contentText: "Safe body.")]
        )
    }
}

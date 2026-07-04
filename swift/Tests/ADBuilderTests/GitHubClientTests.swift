// Gate for the GitHubClient (D3b): tree discovery, raw fetch, and the conditional-GET
// change check — driven by the in-memory HTTPClient stub (no network).

import HTTPTypes
import Testing

@testable import ADBuilder

@Suite("GitHubClient — tree / raw / conditional check")
struct GitHubClientTests {
    private func client(_ handler: @escaping @Sendable (HTTPClientRequest) -> HTTPClientResponse) -> GitHubClient {
        GitHubClient(client: StubHTTPClient(handler), rateLimiter: instantRateLimiter(), token: nil)
    }

    @Test("fetchTree parses the recursive git tree entries")
    func fetchTree() async throws {
        let json = """
            {"tree":[\
            {"path":"proposals/0001-x.md","type":"blob","sha":"abc","size":100},\
            {"path":"proposals","type":"tree","sha":"def"}]}
            """
        let tree = try await client { _ in httpResponse(200, body: json) }
            .fetchTree(owner: "swiftlang", repo: "swift-evolution", branch: "main")
        #expect(tree.count == 2)
        #expect(tree[0].path == "proposals/0001-x.md")
        #expect(tree[0].type == "blob")
        #expect(tree[0].size == 100)
        #expect(tree[1].type == "tree")
    }

    @Test("fetchRaw returns the text plus ETag / Last-Modified validators")
    func fetchRaw() async throws {
        let headers: HTTPFields = [.eTag: "\"v1\"", .lastModified: "Mon, 01 Jan 2024 00:00:00 GMT"]
        let raw = try await client { _ in httpResponse(200, body: "# Proposal", headerFields: headers) }
            .fetchRaw(owner: "o", repo: "r", branch: "main", filePath: "proposals/x.md")
        #expect(raw.text == "# Proposal")
        #expect(raw.etag == "\"v1\"")
        #expect(raw.lastModified == "Mon, 01 Jan 2024 00:00:00 GMT")
    }

    @Test("checkRaw maps 304 → unchanged")
    func checkUnchanged() async throws {
        let result = try await client { _ in httpResponse(304) }
            .checkRaw(owner: "o", repo: "r", branch: "m", filePath: "p", previousEtag: "\"v1\"")
        #expect(result.status == .unchanged)
        #expect(result.changed == false)
    }

    @Test("checkRaw maps 404 → deleted, 200 → modified (carrying the new ETag)")
    func checkDeletedAndModified() async throws {
        let deleted = try await client { _ in httpResponse(404) }
            .checkRaw(owner: "o", repo: "r", branch: "m", filePath: "p", previousEtag: nil)
        #expect(deleted.status == .deleted)
        #expect(deleted.deleted)

        let headers: HTTPFields = [.eTag: "\"v2\""]
        let modified = try await client { _ in httpResponse(200, headerFields: headers) }
            .checkRaw(owner: "o", repo: "r", branch: "m", filePath: "p", previousEtag: "\"v1\"")
        #expect(modified.status == .modified)
        #expect(modified.newState == "\"v2\"")
    }

    @Test("fetchTree throws on a 404 (http-error, not silent)")
    func treeNotFound() async {
        await #expect(throws: GitHubClient.GitHubError.self) {
            _ = try await client { _ in httpResponse(404) }
                .fetchTree(owner: "o", repo: "r", branch: "m")
        }
    }
}

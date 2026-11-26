import AppleDocsSources
import Testing

@Suite("DocC root index (Bun apple/api.js fetchRootIndex + update/docc.js seedNewPagesFromIndex)")
struct DocCRootIndexTests {
    static let index = #"""
        {"interfaceLanguages":{
          "swift":[{"path":"/documentation/compression","title":"Compression","type":"module","children":[
            {"title":"Group","type":"groupMarker"},
            {"path":"/documentation/compression/algorithm","title":"Algorithm","type":"enum","children":[
              {"path":"/documentation/Compression/Algorithm/lzfse","title":"lzfse","type":"case"}]},
            {"path":"/documentation/accelerate/vimage","title":"Elsewhere","type":"class"},
            {"path":"/documentation/compression/ext","title":"External","type":"article","external":true},
            {"path":"compression/relative","title":"No prefix, already lowercase","type":"article"},
            {"path":"Compression/Mixed","title":"No prefix, mixed case","type":"article"}]}],
          "occ":[{"path":"/documentation/compression/compression_encode_buffer","title":"encode","type":"func"},
                 {"path":"/documentation/compression/algorithm","title":"Algorithm (dup)","type":"enum"}]
        }}
        """#

    @Test func `lists the root's page keys with their depths in Bun's visit order`() throws {
        let pages = try DocCRootIndex.pages(fromIndex: Array(Self.index.utf8), rootSlug: "compression")
        #expect(
            pages.map(\.key) == [
                "compression", "compression/algorithm", "compression/algorithm/lzfse", "compression/mixed",
                "compression/compression_encode_buffer"
            ]
        )
        #expect(pages.map(\.depth) == [0, 1, 2, 1, 1])
    }

    @Test func `fetches conditionally and reports unchanged, modified, missing`() async throws {
        let transport = RecordingTransport()
        let url = DocCRootIndex.url(forRoot: "compression")
        #expect(url == "https://developer.apple.com/tutorials/data/index/compression")
        transport.set(url, body: Self.index, etag: "\"v1\"")
        let client = UpstreamHTTPClient(transport: transport)

        guard
            case .modified(let body, let etag) = try await DocCRootIndex.fetch(
                rootSlug: "compression",
                etag: nil,
                client: client
            )
        else {
            Issue.record("expected modified")
            return
        }
        #expect(body == Array(Self.index.utf8) && etag == "\"v1\"")
        #expect(try await DocCRootIndex.fetch(rootSlug: "compression", etag: "\"v1\"", client: client) == .unchanged)
        #expect(transport.requests.last?.ifNoneMatch == "\"v1\"")
        #expect(try await DocCRootIndex.fetch(rootSlug: "nothing", etag: nil, client: client) == .missing)
    }
}

import AemiJSONCore
import AppleDocsCore
import AppleDocsMCP
import AppleDocsStorage
import Foundation
import Testing

@Suite("MCP render_sf_symbol formats (Bun parity)")
struct MCPSymbolRenderTests {
    private static let svg =
        #"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0h10v10z"/></svg>"#

    private static var hasRasterizer: Bool {
        [
            "/opt/homebrew/bin/rsvg-convert", "/usr/local/bin/rsvg-convert", "/usr/bin/rsvg-convert",
            "/opt/homebrew/bin/resvg", "/usr/local/bin/resvg", "/usr/bin/resvg"
        ]
        .contains { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private func call(_ dispatcher: MCPServerDispatcher, _ json: String) async throws -> JSON {
        let response = try #require(await dispatcher.handleRawPayload(Array(json.utf8)))
        return try AemiJSON.parse(response).root
    }

    private func makeDispatcher(in dir: URL) throws -> MCPServerDispatcher {
        let symbols = dir.appendingPathComponent("symbols/public", isDirectory: true)
        try FileManager.default.createDirectory(at: symbols, withIntermediateDirectories: true)
        try Data(Self.svg.utf8).write(to: symbols.appendingPathComponent("star.fill.svg"))
        let store = try CorpusStore(path: dir.appendingPathComponent("corpus.db").path, options: .readWrite)
        store.close()
        return MCPServerDispatcher(
            databasePath: dir.appendingPathComponent("corpus.db").path,
            resourcesDirectory: dir.path
        )
    }

    @Test func `svg format inlines the SVG; png format returns a resource URI; schema exposes format`() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
            "apple-docs-mcp-sym-\(UUID().uuidString)"
        )
        defer { try? FileManager.default.removeItem(at: dir) }
        let dispatcher = try makeDispatcher(in: dir)
        defer { Task { await dispatcher.close() } }

        let svgResult = try await call(
            dispatcher,
            #"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"render_sf_symbol","arguments":{"name":"star.fill","format":"svg"}}}"#
        )
        let svgPayload = try AemiJSON.parse(Array((svgResult["result"]["content"][index: 0]["text"].string ?? "").utf8))
            .root
        #expect(svgPayload["name"].string == "star.fill")
        #expect(svgPayload["scope"].string == "public")
        #expect(svgPayload["format"].string == "svg")
        #expect(svgPayload["resourceUri"].string == "apple-docs://sf-symbol/public/star.fill.svg")
        #expect(svgPayload["svg"].string?.contains("<svg") == true)

        let pngResult = try await call(
            dispatcher,
            #"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"render_sf_symbol","arguments":{"name":"star.fill"}}}"#
        )
        let pngPayload = try AemiJSON.parse(Array((pngResult["result"]["content"][index: 0]["text"].string ?? "").utf8))
            .root
        #expect(pngPayload["format"].string == "png")
        #expect(pngPayload["resourceUri"].string == "apple-docs://sf-symbol/public/star.fill.png")
        #expect(!pngPayload["svg"].exists)

        let tools = try await call(dispatcher, #"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#)
        let render = (tools["result"]["tools"].array ?? []).first { $0["name"].string == "render_sf_symbol" }
        #expect(render?["inputSchema"]["properties"]["format"]["enum"].array?.compactMap(\.string) == ["svg", "png"])

        let missing = try await call(
            dispatcher,
            #"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"render_sf_symbol","arguments":{"name":"nope","format":"svg"}}}"#
        )
        #expect(missing["result"]["isError"].bool == true)
    }

    @Test(.enabled(if: MCPSymbolRenderTests.hasRasterizer))
    func `png resource rasterizes to a base64 PNG blob`() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
            "apple-docs-mcp-png-\(UUID().uuidString)"
        )
        defer { try? FileManager.default.removeItem(at: dir) }
        let dispatcher = try makeDispatcher(in: dir)
        defer { Task { await dispatcher.close() } }

        let result = try await call(
            dispatcher,
            #"{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"apple-docs://sf-symbol/public/star.fill.png?size=32"}}"#
        )
        let content = result["result"]["contents"][index: 0]
        #expect(content["mimeType"].string == "image/png")
        let blob = try #require(content["blob"].string.flatMap { Data(base64Encoded: $0) })
        #expect(Array(blob.prefix(8)) == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    }
}

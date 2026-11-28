import AemiJSONCore
import AemiJSONRPC
import AemiMCP
import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import Foundation
import OrderedCollections

extension MCPServerDispatcher {
    /// The static MCP URI templates (`apple-docs://doc/{+key}`, `apple-docs://framework/{slug}`,
    /// `apple-docs://sf-symbol/{scope}/{name}.{format}`).
    static let resourceTemplates = [
        MCPResourceTemplate(
            uriTemplate: "apple-docs://doc/{+key}",
            name: "doc",
            description: "Read a documentation page as Markdown by canonical key.",
            mimeType: "text/markdown"
        ),
        MCPResourceTemplate(
            uriTemplate: "apple-docs://framework/{slug}",
            name: "framework",
            description: "Browse documents inside a framework or collection.",
            mimeType: "application/json"
        ),
        MCPResourceTemplate(
            uriTemplate: "apple-docs://sf-symbol/{scope}/{name}.{format}",
            name: "sf-symbol",
            description: "Read or render an SF Symbol asset (format svg or png; optional ?size=&color=&background=).",
            mimeType: "application/octet-stream"
        )
    ]

    /// The concrete `apple-docs://framework/<slug>` resources available in the active corpus.
    func resources() async throws(JSONRPCError) -> [MCPResource] {
        do {
            let roots = try await reader.withStore { try CorpusQueryService.listFrameworks(on: $0) }
            return roots.map { root in
                MCPResource(
                    uri: "apple-docs://framework/\(root.slug)",
                    name: root.displayName,
                    mimeType: "application/json"
                )
            }
        } catch {
            throw JSONRPCError(code: JSONRPCError.internalError, message: "Failed listing resources.")
        }
    }

    /// Reads an `apple-docs://` resource URI (`doc/`, `framework/`, or `sf-symbol/`).
    func readResource(_ uri: String) async throws(JSONRPCError) -> [MCPResourceContents] {
        do {
            if uri.hasPrefix("apple-docs://doc/") {
                return try await readDocResource(uri: uri, rawKey: String(uri.dropFirst("apple-docs://doc/".count)))
            }
            if uri.hasPrefix("apple-docs://framework/") {
                return try await readFrameworkResource(
                    uri: uri,
                    slug: String(uri.dropFirst("apple-docs://framework/".count))
                )
            }
            if uri.hasPrefix("apple-docs://sf-symbol/") {
                return try await readSymbolResource(
                    uri: uri,
                    tail: String(uri.dropFirst("apple-docs://sf-symbol/".count))
                )
            }
        } catch let rpcError as JSONRPCError {
            throw rpcError
        } catch {
            throw JSONRPCError(code: JSONRPCError.internalError, message: "Resource read failed.")
        }
        throw JSONRPCError(code: JSONRPCError.invalidParams, message: "Unsupported resource URI: \(uri)")
    }

    private func readDocResource(uri: String, rawKey: String) async throws -> [MCPResourceContents] {
        let key: DocumentKey
        do {
            key = try DocumentKey(rawKey)
        } catch {
            throw JSONRPCError(code: JSONRPCError.invalidParams, message: "Invalid document key.")
        }
        let markdown: String
        if let cached = await markdownCache.get(key.rawValue) {
            markdown = cached
        } else {
            guard let detail = try await reader.withStore({ try CorpusQueryService.readDocument(key: key, on: $0) })
            else {
                throw JSONRPCError(code: JSONRPCError.invalidParams, message: "Document not found.")
            }
            markdown = detail.renderMarkdown()
            await markdownCache.set(key.rawValue, value: markdown)
        }
        return [.text(uri: uri, mimeType: "text/markdown", markdown)]
    }

    private func readFrameworkResource(uri: String, slug: String) async throws -> [MCPResourceContents] {
        let entries = try await reader.withConnection { conn in
            try CorpusQueryService.browse(framework: slug, limit: 100, on: conn)
        }
        let json = try PublicProjection.encodeJSON(entries)
        return [.text(uri: uri, mimeType: "application/json", json)]
    }

    private func readSymbolResource(uri: String, tail: String) async throws -> [MCPResourceContents] {
        let target = tail.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let parts = target[0].split(separator: "/", maxSplits: 1)
        let format = parts.count == 2 && parts[1].hasSuffix(".png") ? "png" : "svg"
        guard parts.count == 2, parts[1].hasSuffix(".\(format)"),
            let name = String(parts[1].dropLast(format.count + 1)).removingPercentEncoding
        else {
            throw JSONRPCError(code: JSONRPCError.invalidParams, message: "Invalid SF Symbol resource URI.")
        }
        var query: [String: String] = [:]
        for pair in (target.count > 1 ? target[1] : "").split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            if kv.count == 2 { query[String(kv[0])] = String(kv[1]).removingPercentEncoding }
        }
        let scope = String(parts[0])
        let size = query["size"].flatMap(Int.init) ?? 128
        let color = query["color"] ?? query["fg"] ?? "#000000"
        let background = query["background"] ?? query["bg"] ?? "transparent"
        let resourcesDir = reader.resourcesDirectory
        if format == "png" {
            let png = try await renderPermits.withPermit {
                try await AssetRenderService.renderSFSymbolPNG(
                    name: name,
                    scope: scope,
                    size: size,
                    color: color,
                    background: background,
                    resourcesDirectory: resourcesDir
                )
            }
            return [.blob(uri: uri, mimeType: "image/png", base64: Data(png).base64EncodedString())]
        }
        let svg = try await renderPermits.withPermit {
            try AssetRenderService.renderSFSymbolSVG(
                name: name,
                scope: scope,
                size: size,
                color: color,
                background: background,
                resourcesDirectory: resourcesDir
            )
        }
        return [.text(uri: uri, mimeType: "image/svg+xml", svg)]
    }
}

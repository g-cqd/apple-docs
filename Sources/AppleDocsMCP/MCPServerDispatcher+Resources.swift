import AemiJSONCore
import AemiJSONRPC
import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import Foundation
import OrderedCollections

extension MCPServerDispatcher {
    /// Returns the static MCP URI templates (`apple-docs://doc/{+key}`, `apple-docs://framework/{slug}`,
    /// `apple-docs://sf-symbol/{scope}/{name}.{format}`).
    func resourceTemplatesResult() -> JSONValue {
        .object([
            "resourceTemplates": .array([
                .object([
                    "uriTemplate": .string("apple-docs://doc/{+key}"),
                    "name": .string("doc"),
                    "description": .string("Read a documentation page as Markdown by canonical key."),
                    "mimeType": .string("text/markdown")
                ]),
                .object([
                    "uriTemplate": .string("apple-docs://framework/{slug}"),
                    "name": .string("framework"),
                    "description": .string("Browse documents inside a framework or collection."),
                    "mimeType": .string("application/json")
                ]),
                .object([
                    "uriTemplate": .string("apple-docs://sf-symbol/{scope}/{name}.{format}"),
                    "name": .string("sf-symbol"),
                    "description": .string(
                        "Read or render an SF Symbol asset (format svg or png; optional ?size=&color=&background=)."
                    ),
                    "mimeType": .string("application/octet-stream")
                ])
            ])
        ])
    }

    /// Lists concrete `apple-docs://framework/<slug>` resources available in the active corpus.
    func handleResourcesList() async -> Result<JSONValue, JSONRPCError> {
        do {
            let roots = try await reader.withStore { try CorpusQueryService.listFrameworks(on: $0) }
            let resources: [JSONValue] = roots.map { root in
                .object([
                    "uri": .string("apple-docs://framework/\(root.slug)"),
                    "name": .string(root.displayName),
                    "mimeType": .string("application/json")
                ])
            }
            return .success(.object(["resources": .array(resources)]))
        } catch {
            return .failure(JSONRPCError(code: JSONRPCError.internalError, message: "Failed listing resources."))
        }
    }

    /// Reads an `apple-docs://` resource URI (`doc/`, `framework/`, or `sf-symbol/`).
    func handleResourceRead(_ params: JSON?) async -> Result<JSONValue, JSONRPCError> {
        guard let uri = params?["uri"].string, !uri.isEmpty else {
            return .failure(JSONRPCError(code: JSONRPCError.invalidParams, message: "resources/read requires 'uri'."))
        }
        do {
            if uri.hasPrefix("apple-docs://doc/") {
                let rawKey = String(uri.dropFirst("apple-docs://doc/".count))
                return try await readDocResource(uri: uri, rawKey: rawKey)
            }
            if uri.hasPrefix("apple-docs://framework/") {
                let slug = String(uri.dropFirst("apple-docs://framework/".count))
                return try await readFrameworkResource(uri: uri, slug: slug)
            }
            if uri.hasPrefix("apple-docs://sf-symbol/") {
                let tail = String(uri.dropFirst("apple-docs://sf-symbol/".count))
                return try await readSymbolResource(uri: uri, tail: tail)
            }
            return .failure(JSONRPCError(code: JSONRPCError.invalidParams, message: "Unsupported resource URI: \(uri)"))
        } catch let rpcError as JSONRPCError {
            return .failure(rpcError)
        } catch {
            return .failure(JSONRPCError(code: JSONRPCError.internalError, message: "Resource read failed."))
        }
    }

    private func readDocResource(uri: String, rawKey: String) async throws -> Result<JSONValue, JSONRPCError> {
        let key: DocumentKey
        do {
            key = try DocumentKey(rawKey)
        } catch {
            return .failure(JSONRPCError(code: JSONRPCError.invalidParams, message: "Invalid document key."))
        }
        let markdown: String
        if let cached = await markdownCache.get(key.rawValue) {
            markdown = cached
        } else {
            guard let detail = try await reader.withStore({ try CorpusQueryService.readDocument(key: key, on: $0) })
            else {
                return .failure(JSONRPCError(code: JSONRPCError.invalidParams, message: "Document not found."))
            }
            markdown = detail.renderMarkdown()
            await markdownCache.set(key.rawValue, value: markdown)
        }
        return .success(resourceContent(uri: uri, mimeType: "text/markdown", text: markdown))
    }

    private func readFrameworkResource(uri: String, slug: String) async throws -> Result<JSONValue, JSONRPCError> {
        let entries = try await reader.withConnection { conn in
            try CorpusQueryService.browse(framework: slug, limit: 100, on: conn)
        }
        let json = try PublicProjection.encodeJSON(entries)
        return .success(resourceContent(uri: uri, mimeType: "application/json", text: json))
    }

    private func readSymbolResource(uri: String, tail: String) async throws -> Result<JSONValue, JSONRPCError> {
        let target = tail.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let parts = target[0].split(separator: "/", maxSplits: 1)
        let format = parts.count == 2 && parts[1].hasSuffix(".png") ? "png" : "svg"
        guard parts.count == 2, parts[1].hasSuffix(".\(format)"),
            let name = String(parts[1].dropLast(format.count + 1)).removingPercentEncoding
        else {
            return .failure(JSONRPCError(code: JSONRPCError.invalidParams, message: "Invalid SF Symbol resource URI."))
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
            let content: JSONValue = .object([
                "uri": .string(uri), "mimeType": .string("image/png"), "blob": .string(Data(png).base64EncodedString())
            ])
            return .success(.object(["contents": .array([content])]))
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
        return .success(resourceContent(uri: uri, mimeType: "image/svg+xml", text: svg))
    }

    private func resourceContent(uri: String, mimeType: String, text: String) -> JSONValue {
        .object([
            "contents": .array([
                .object([
                    "uri": .string(uri),
                    "mimeType": .string(mimeType),
                    "text": .string(text)
                ])
            ])
        ])
    }
}

import AemiJSONCore
import AemiJSONRPC
import AppleDocsCommands
import AppleDocsOutput
import AppleDocsStorage

/// Asset tools: `search_sf_symbols`, `list_apple_fonts`, `render_sf_symbol`, `render_font_text`.
extension MCPServerDispatcher {
    func invokeRenderSFSymbol(_ args: JSON) async throws -> String {
        let name = try requiredString(args, key: "name", tool: "render_sf_symbol")
        let options = SFSymbolRenderArgs(args: args)
        let resourcesDir = reader.resourcesDirectory
        // Rendering the SVG validates the name and the asset for both formats; PNG bytes are served by the
        // `apple-docs://sf-symbol/<scope>/<name>.png` resource so tool results stay small (Bun parity).
        let svg = try await renderWithPermit {
            try AssetRenderService.renderSFSymbolSVG(
                name: name,
                scope: options.scope,
                size: options.size,
                color: options.color,
                background: options.background,
                resourcesDirectory: resourcesDir
            )
        }
        return try PublicProjection.encodeJSON(
            PublicSymbolRender(
                name: name,
                scope: options.scope,
                format: options.format,
                svg: options.format == "svg" ? svg : nil
            )
        )
    }

    func invokeRenderFontText(_ args: JSON) async throws -> String {
        let fontID = try requiredString(args, key: "fontId", tool: "render_font_text")
        let text = args["text"].string ?? "AaBbCc 0123"
        let size = Double(args["size"].int ?? 96)  // Bun `renderFontText` default point size
        let dbPath = reader.databasePath
        return try await renderWithPermit {
            let conn = try SQLiteConnection(path: dbPath, options: .readOnly)
            defer { conn.close() }
            return try await AssetRenderService.renderFontTextSVG(fontID: fontID, text: text, size: size, on: conn)
        }
    }

    func renderWithPermit(_ work: @escaping @Sendable () async throws -> String) async throws -> String {
        try await renderPermits.withPermit(work)
    }
}

private struct SFSymbolRenderArgs: Sendable {
    let scope: String
    let format: String
    let size: Int
    let color: String
    let background: String

    init(args: JSON) {
        self.scope = args["scope"].string == "private" ? "private" : "public"
        self.format = args["format"].string == "svg" ? "svg" : "png"
        self.size = args["size"].int ?? 64  // Bun `renderSfSymbol` default point size
        self.color = args["color"].string ?? "#000000"  // Bun default
        self.background = args["background"].string ?? "transparent"
    }
}

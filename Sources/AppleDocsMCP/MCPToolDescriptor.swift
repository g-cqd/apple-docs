/// Specification of an MCP tool registered on the `apple-docs` server.
public struct MCPToolDescriptor: Hashable, Sendable {
    public let name: String
    public let isAssetTool: Bool
    public let isReadOnly: Bool

    public init(name: String, isAssetTool: Bool, isReadOnly: Bool = true) {
        self.name = name
        self.isAssetTool = isAssetTool
        self.isReadOnly = isReadOnly
    }

    /// Canonical list of all nine read-only tools exposed by the MCP server.
    public static let allTools: [Self] = [
        Self(name: "search_docs", isAssetTool: false),
        Self(name: "read_doc", isAssetTool: false),
        Self(name: "list_frameworks", isAssetTool: false),
        Self(name: "browse", isAssetTool: false),
        Self(name: "list_taxonomy", isAssetTool: false),
        Self(name: "search_sf_symbols", isAssetTool: true),
        Self(name: "list_apple_fonts", isAssetTool: true),
        Self(name: "render_sf_symbol", isAssetTool: true),
        Self(name: "render_font_text", isAssetTool: true)
    ]
}

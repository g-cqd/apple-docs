public import AemiJSONCore
import Foundation
import OrderedCollections

/// Specification and JSON Schema loader for each of the nine read-only MCP tools exposed by
/// `apple-docs` (`tools/list`), backed by the bundled `mcp-tools.json` schema catalog.
public struct MCPToolDescriptor: Equatable, Sendable {
    public let name: String
    public let description: String
    public let isAssetTool: Bool
    public let isReadOnly: Bool
    public let inputSchema: JSONValue

    public init(
        name: String,
        description: String = "",
        isAssetTool: Bool,
        isReadOnly: Bool = true,
        inputSchema: JSONValue = .null
    ) {
        self.name = name
        self.description = description
        self.isAssetTool = isAssetTool
        self.isReadOnly = isReadOnly
        self.inputSchema = inputSchema == .null ? .object(["type": .string("object")]) : inputSchema
    }

    /// Canonical list of all nine read-only tools loaded from `mcp-tools.json`.
    public static let allTools: [Self] = loadCatalog()

    private static func loadCatalog() -> [Self] {
        guard let url = Bundle.module.url(forResource: "mcp-tools", withExtension: "json"),
            let data = try? Data(contentsOf: url),
            let doc = try? AemiJSON.parse(Array(data)),
            let items = doc.root.array
        else {
            return []
        }
        return items.compactMap { item -> Self? in
            guard let name = item["name"].string else { return nil }
            return Self(
                name: name,
                description: item["description"].string ?? "",
                isAssetTool: item["isAssetTool"].bool ?? false,
                isReadOnly: true,
                inputSchema: JSONValue(item["inputSchema"])
            )
        }
    }
}

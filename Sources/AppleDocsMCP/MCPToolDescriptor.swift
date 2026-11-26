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
    /// The input JSON Schema as compact JSON text. Descriptors live in a process-lifetime global, and LeakSanitizer
    /// on Linux reports recursive enum values reachable only from globals, so the schema is not kept materialized.
    public let inputSchemaJSON: String

    /// The input JSON Schema, materialized on each access (once per `tools/list`).
    public var inputSchema: JSONValue {
        guard let document = try? AemiJSON.parse(Array(inputSchemaJSON.utf8)) else { return Self.emptySchema }
        return JSONValue(document.root)
    }

    private static var emptySchema: JSONValue { .object(["type": .string("object")]) }

    public init(
        name: String,
        description: String = "",
        isAssetTool: Bool,
        isReadOnly: Bool = true,
        inputSchema: JSONValue = .null
    ) {
        self.init(
            name: name,
            description: description,
            isAssetTool: isAssetTool,
            isReadOnly: isReadOnly,
            inputSchemaJSON: Self.compact(inputSchema == .null ? Self.emptySchema : inputSchema)
        )
    }

    private init(name: String, description: String, isAssetTool: Bool, isReadOnly: Bool, inputSchemaJSON: String) {
        self.name = name
        self.description = description
        self.isAssetTool = isAssetTool
        self.isReadOnly = isReadOnly
        self.inputSchemaJSON = inputSchemaJSON
    }

    /// Canonical list of all nine read-only tools loaded from `mcp-tools.json`.
    public static let allTools: [Self] = loadCatalog()

    private static func loadCatalog() -> [Self] {
        guard let doc = try? AemiJSON.parse(Array(EmbeddedMCPTools.text.utf8)), let items = doc.root.array
        else {
            return []
        }
        return items.compactMap { item -> Self? in
            guard let name = item["name"].string else { return nil }
            let schema = item["inputSchema"]
            return Self(
                name: name,
                description: item["description"].string ?? "",
                isAssetTool: item["isAssetTool"].bool ?? false,
                isReadOnly: true,
                inputSchemaJSON: schema.exists && !schema.isNull ? compact(JSONValue(schema)) : compact(emptySchema)
            )
        }
    }

    private static func compact(_ value: JSONValue) -> String {
        (try? value.encodedBytes()).map { String(decoding: $0, as: UTF8.self) } ?? #"{"type":"object"}"#
    }
}

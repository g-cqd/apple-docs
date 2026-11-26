import AemiJSONCore
import AppleDocsMCP
import OrderedCollections
import Testing

@Suite("MCP tool descriptors")
struct MCPToolDescriptorTests {
    @Test func `the catalog lists nine read-only tools with their JSON schemas`() {
        let tools = MCPToolDescriptor.allTools
        #expect(tools.count == 9)
        #expect(tools.allSatisfy { $0.isReadOnly })
        let search = tools.first { $0.name == "search_docs" }
        guard case .object(let schema)? = search?.inputSchema, case .object(let properties)? = schema["properties"]
        else {
            Issue.record("search_docs has no object schema with properties")
            return
        }
        #expect(schema["type"] == .string("object"))
        #expect(properties["query"] != nil)
    }

    /// The catalog global keeps schemas as JSON text, not materialized `JSONValue` trees: LeakSanitizer on Linux
    /// reports recursive enum values reachable only from a global (see docs/verification.md, "Sanitizers").
    @Test func `schemas are stored as JSON text and materialized on demand`() {
        let descriptor = MCPToolDescriptor(name: "t", isAssetTool: false)
        #expect(descriptor.inputSchemaJSON == #"{"type":"object"}"#)
        #expect(descriptor.inputSchema == .object(["type": .string("object")]))
    }
}

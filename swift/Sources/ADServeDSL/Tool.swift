// The MCP Tool DSL (RFC 0005 Phase C). Mirrors the route DSL: `Tool("name", "desc")`
// → `.input(SomeInput.self)` / `.respond { input, ctx in … }`, collected by
// `@ToolBuilder` into a `ToolRegistry` (an `MCPToolProviding` the engine dispatches).
//
// The input schema + decoding both come from ADJSON's `@Schemable` macro applied to a
// `Decodable` input struct (D-0005-10): the macro derives the JSON Schema from the
// stored properties (no zod, no hand-rolled builder), and `.respond` receives the
// decoded typed value. The macro's schema is STRUCTURAL (types + required + nesting; no
// descriptions/enums/bounds), so `tools/list` schemas are leaner than the JS MCP's zod
// schemas — the parity gate is the `tools/call` behavior, not the schema text.

import ADJSON
import ADServeCore

/// The standard read-only tool annotations (every apple-docs tool is read-only).
public enum ToolAnnotations {
  public static let readOnly: JSONValue = .object([
    "readOnlyHint": .bool(true),
    "idempotentHint": .bool(true),
    "destructiveHint": .bool(false),
    "openWorldHint": .bool(false),
  ])
}

private let emptyObjectSchema: JSONValue = .object(["type": .string("object")])

/// A tool with a typed `@Schemable` input. `.respond` finishes it.
public struct TypedToolStub<Input: ADJSONSchemaProviding & Decodable> {
  let name: String
  let description: String
  let annotations: JSONValue

  /// Finish the tool: the handler receives the decoded input + the call context.
  public func respond(
    _ handler: @escaping @Sendable (Input, MCPToolContext) -> MCPToolResult
  ) -> ToolDeclaration {
    let name = self.name
    // `jsonSchemaText` is the public rooted document (carries `$schema` when the input's
    // `@Schemable(dialect:)` requests one); the `__adjsonSchemaText` SPI is the bare fragment.
    let schema = (try? JSONValue(parsing: Input.jsonSchemaText)) ?? emptyObjectSchema
    return ToolDeclaration(
      definition: MCPToolDefinition(
        name: name, description: description, inputSchema: schema, annotations: annotations),
      handler: { arguments, context in
        guard let data = try? arguments.encoded(),
          let decoded = try? ADJSON.JSONDecoder().decode(Input.self, from: data)
        else { return .failure("Invalid arguments for tool \(name).") }
        return handler(decoded, context)
      })
  }
}

/// A tool under construction (name + description). `.input` adds a typed schema;
/// `.respond` (without `.input`) finishes a no-argument tool.
public struct ToolStub {
  let name: String
  let description: String
  var annotations: JSONValue = ToolAnnotations.readOnly

  /// Mark the tool read-only (the default; explicit for readability).
  public var readOnly: ToolStub {
    var copy = self
    copy.annotations = ToolAnnotations.readOnly
    return copy
  }

  /// Declare the tool's input type — `@Schemable & Decodable`. The schema is derived
  /// from the type; `.respond` receives the decoded value.
  public func input<Input: ADJSONSchemaProviding & Decodable>(_ type: Input.Type)
    -> TypedToolStub<Input>
  {
    TypedToolStub(name: name, description: description, annotations: annotations)
  }

  /// Finish a no-argument tool.
  public func respond(_ handler: @escaping @Sendable (MCPToolContext) -> MCPToolResult)
    -> ToolDeclaration
  {
    ToolDeclaration(
      definition: MCPToolDefinition(
        name: name, description: description, inputSchema: emptyObjectSchema, annotations: annotations),
      handler: { _, context in handler(context) })
  }
}

/// A fully-built tool (definition + handler).
public struct ToolDeclaration: Sendable {
  let definition: MCPToolDefinition
  let handler: @Sendable (JSONValue, MCPToolContext) -> MCPToolResult
}

/// Begin a tool declaration.
public func Tool(_ name: String, _ description: String) -> ToolStub {
  ToolStub(name: name, description: description)
}

// MARK: - Builder + registry

@resultBuilder
public enum ToolBuilder {
  public static func buildExpression(_ tool: ToolDeclaration) -> [ToolDeclaration] { [tool] }
  public static func buildBlock(_ parts: [ToolDeclaration]...) -> [ToolDeclaration] { parts.flatMap { $0 } }
  public static func buildArray(_ parts: [[ToolDeclaration]]) -> [ToolDeclaration] { parts.flatMap { $0 } }
  public static func buildOptional(_ part: [ToolDeclaration]?) -> [ToolDeclaration] { part ?? [] }
  public static func buildEither(first: [ToolDeclaration]) -> [ToolDeclaration] { first }
  public static func buildEither(second: [ToolDeclaration]) -> [ToolDeclaration] { second }
}

/// The tool table the MCP dispatcher resolves against. Declaration order for
/// `tools/list`; O(1) by-name for `tools/call`.
public struct ToolRegistry: MCPToolProviding {
  private let order: [ToolDeclaration]
  private let byName: [String: ToolDeclaration]

  public init(@ToolBuilder _ build: () -> [ToolDeclaration]) {
    self.init(tools: build())
  }

  public init(tools: [ToolDeclaration]) {
    order = tools
    byName = Dictionary(tools.map { ($0.definition.name, $0) }, uniquingKeysWith: { _, latest in latest })
  }

  public var toolDefinitions: [MCPToolDefinition] { order.map(\.definition) }

  public func invoke(name: String, arguments: JSONValue, context: MCPToolContext) -> MCPToolResult {
    guard let tool = byName[name] else { return .failure("Tool not found: \(name)") }
    return tool.handler(arguments, context)
  }
}

// The Streamable HTTP MCP transport (RFC 0005 Phase D1): POST /mcp + OPTIONS /mcp.
// Stateless JSON-RPC over HTTP — reuses the in-house `MCPDispatcher` with a per-request
// pooled connection (the `.storage` checkout). Ports the request/response behavior of
// src/mcp/http-server.js (single `application/json` object, not SSE; origin check;
// CORS). The heavy-tool semaphore + JSON-RPC body batching are a D1b follow-on.

import ADJSON
import ADServeCore
import ADServeDSL
import HTTPTypes

/// `POST /mcp` — origin-gate, dispatch the JSON-RPC body, return `application/json`.
func handleMCPPost(_ ctx: StorageContext, dispatcher: MCPDispatcher) -> ResponseContent {
  let origin = ctx.headers[originName]
  guard originAllowed(origin) else {
    return mcpRpcError(code: -32000, message: "Origin not allowed", status: .forbidden, origin: nil)
  }
  let context = MCPToolContext(connection: ctx.connection, logger: ctx.logger)
  guard let response = dispatcher.handle(line: String(decoding: ctx.body, as: UTF8.self), context: context)
  else {
    // A notification (no id) → 202 Accepted, empty body.
    return .full(body: [], contentType: "application/json", status: .accepted, headers: mcpHeaders(origin: origin))
  }
  return .full(
    body: response, contentType: "application/json", status: .ok, headers: mcpHeaders(origin: origin))
}

/// `OPTIONS /mcp` — the CORS preflight.
func handleMCPOptions(_ ctx: RequestContext) -> ResponseContent {
  let origin = ctx.headers[originName]
  let status: HTTPResponse.Status = originAllowed(origin) ? .noContent : .forbidden
  return .full(body: [], contentType: "text/plain", status: status, headers: corsPreflightHeaders(origin: origin))
}

// MARK: - origin + headers

private let originName = HTTPField.Name("origin")!

/// Loopback origins (and an absent Origin) are allowed; no configured allow-list yet.
private func originAllowed(_ origin: String?) -> Bool {
  guard let origin else { return true }
  let lower = origin.lowercased()
  return lower.contains("localhost") || lower.contains("127.0.0.1") || lower.contains("[::1]")
}

private func field(_ name: String) -> HTTPField.Name { HTTPField.Name(name)! }

/// The MCP `/mcp` response headers (distinct from the web envelope) + CORS echo.
private func mcpHeaders(origin: String?) -> HTTPFields {
  var fields = HTTPFields()
  fields[field("referrer-policy")] = "no-referrer"
  fields[field("vary")] = "Origin"
  if let origin { fields[field("access-control-allow-origin")] = origin }
  return fields
}

private func corsPreflightHeaders(origin: String?) -> HTTPFields {
  var fields = HTTPFields()
  fields[field("access-control-allow-methods")] = "GET, POST, DELETE, OPTIONS"
  fields[field("access-control-allow-headers")] = "content-type, mcp-session-id, mcp-protocol-version, last-event-id"
  fields[field("access-control-expose-headers")] = "mcp-session-id"
  fields[field("access-control-max-age")] = "86400"
  fields[field("vary")] = "Origin"
  if let origin { fields[field("access-control-allow-origin")] = origin }
  return fields
}

private func mcpRpcError(code: Int, message: String, status: HTTPResponse.Status, origin: String?)
  -> ResponseContent
{
  let body = JSONValue.object([
    "jsonrpc": .string("2.0"),
    "error": .object(["code": .number(Double(code)), "message": .string(message)]),
  ])
  let bytes = (try? body.encoded()).map { Array($0) } ?? Array("{}".utf8)
  return .full(body: bytes, contentType: "application/json", status: status, headers: mcpHeaders(origin: origin))
}

// The Streamable HTTP MCP transport: POST /mcp + OPTIONS /mcp.
// Stateless JSON-RPC over HTTP — reuses the in-house `MCPDispatcher` with a per-request
// pooled connection (the `.storage` checkout). Single `application/json` object, not SSE;
// origin check; CORS.

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
/// Mirrors JS `isLoopbackOrigin`: an http(s) origin whose host is exactly
/// localhost / 127.0.0.1 / [::1]. Substring matching is unsafe — `http://
/// localhost.evil.com` must NOT pass (CWE-346/1385 DNS-rebinding bypass).
func originAllowed(_ origin: String?) -> Bool {
  guard let origin else { return true }
  guard let host = loopbackOriginHost(origin) else { return false }
  return host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}

/// The lowercased host of an `http(s)://` origin (IPv6 keeps its brackets, as
/// WHATWG `URL.hostname` does), or nil if the string isn't such an origin.
func loopbackOriginHost(_ origin: String) -> String? {
  let lower = origin.lowercased()
  let scheme: String
  if lower.hasPrefix("http://") {
    scheme = "http://"
  } else if lower.hasPrefix("https://") {
    scheme = "https://"
  } else {
    return nil
  }
  var authority = lower.dropFirst(scheme.count)
  if let end = authority.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) {
    authority = authority[..<end]
  }
  if let at = authority.lastIndex(of: "@") { authority = authority[authority.index(after: at)...] }
  if authority.first == "[" {
    guard let close = authority.firstIndex(of: "]") else { return nil }
    return String(authority[...close])
  }
  if let colon = authority.firstIndex(of: ":") { return String(authority[..<colon]) }
  return authority.isEmpty ? nil : String(authority)
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

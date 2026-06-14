// The web-response envelope shared by every ad-server route (RFC 0001 P6 web
// slice). Mirrors the Bun web server's cross-cutting layer (src/web/serve.js +
// responses.js + context.js): every response carries the constant security
// header set + the RFC 8288 `Link` set + `Vary: Accept` + an `X-Request-Id`,
// and a `hashable` response gets a SHA-256-prefix ETag with a 304 on a matching
// `If-None-Match` (src/web/responses.js:finalizeResponse). Gzip is Caddy's job
// (the upstream stays uncompressed), so this only frames the uncompressed body.

import Crypto
import NIOCore
import NIOHTTP1

struct WebResponse {
  var status: HTTPResponseStatus
  var contentType: String
  var cacheControl: String?
  var hashable: Bool
  var body: [UInt8]

  init(
    status: HTTPResponseStatus = .ok, contentType: String, cacheControl: String? = nil,
    hashable: Bool = false, body: [UInt8]
  ) {
    self.status = status
    self.contentType = contentType
    self.cacheControl = cacheControl
    self.hashable = hashable
    self.body = body
  }

  /// `application/json;charset=utf-8` (Bun `Response.json`'s content-type).
  static func json(_ body: [UInt8], cacheControl: String? = nil, hashable: Bool = false) -> WebResponse {
    WebResponse(
      contentType: "application/json;charset=utf-8", cacheControl: cacheControl,
      hashable: hashable, body: body)
  }

  static func text(
    _ body: [UInt8], contentType: String, cacheControl: String? = nil, hashable: Bool = false
  ) -> WebResponse {
    WebResponse(contentType: contentType, cacheControl: cacheControl, hashable: hashable, body: body)
  }

  static func plain(_ status: HTTPResponseStatus, _ message: String) -> WebResponse {
    WebResponse(status: status, contentType: "text/plain; charset=utf-8", body: Array(message.utf8))
  }
}

enum WebConst {
  // Content-Security-Policy (src/web/csp.js). DEVIATION: the JS policy's
  // `script-src` carries a `'sha256-…'` hash for the 404 page's inline IIFE;
  // ad-server serves no inline scripts in this slice (the 404 HTML page is out
  // of scope), and CSP is inert on JSON/text API responses, so the hash is
  // omitted. The web-routes parity test normalizes this one token.
  static let csp =
    "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; "
    + "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; "
    + "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

  // Applied to every response (src/web/context.js:231-239). Lowercase names —
  // HTTP header names are case-insensitive; clients/Caddy normalize.
  static let securityHeaders: [(String, String)] = [
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "strict-origin-when-cross-origin"),
    ("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()"),
    ("cross-origin-opener-policy", "same-origin"),
    ("cross-origin-resource-policy", "same-origin"),
    ("content-security-policy", csp),
  ]

  // RFC 8288 Link set on every response (src/web/discovery.js:49-54).
  static let discoveryLinks =
    #"</sitemap.xml>; rel="sitemap", </.well-known/api-catalog>; rel="api-catalog", </docs/>; rel="service-doc", </opensearch.xml>; rel="search""#

  // Cache directive for corpus-derived JSON (src/web/responses.js:API_CORPUS_CACHE_CONTROL).
  static let apiCorpusCacheControl = "public, max-age=300, stale-while-revalidate=3600"

  // Discovery endpoints are a pure function of siteConfig (src/web/routes/discovery.route.js).
  static let discoveryCacheControl = "public, max-age=3600"
}

/// Lowercase-hex SHA-256 (matches JS `Bun.CryptoHasher('sha256').digest('hex')`).
func sha256HexLower(_ bytes: [UInt8]) -> String {
  var hasher = SHA256()
  bytes.withUnsafeBytes { hasher.update(bufferPointer: $0) }
  let digest = hasher.finalize()
  let hex: [UInt8] = Array("0123456789abcdef".utf8)
  var out = [UInt8]()
  out.reserveCapacity(64)  // SHA-256 → 32 bytes → 64 hex chars
  for b in digest {
    out.append(hex[Int(b >> 4)])
    out.append(hex[Int(b & 0xF)])
  }
  return String(decoding: out, as: UTF8.self)
}

/// Loose RFC 7232 If-None-Match (src/web/responses.js:matchesIfNoneMatch):
/// `*`, a single tag, or a comma list; the strong/weak prefix is compared verbatim.
func matchesIfNoneMatch(_ headerValue: String, _ etag: String) -> Bool {
  let value = trimOWS(headerValue[...])
  if value == "*" { return true }
  for part in value.split(separator: ",") where trimOWS(part) == etag[...] { return true }
  return false
}

private func trimOWS(_ s: Substring) -> Substring {
  var sub = s
  while let f = sub.first, f == " " || f == "\t" { sub = sub.dropFirst() }
  while let l = sub.last, l == " " || l == "\t" { sub = sub.dropLast() }
  return sub
}

/// Echo a valid inbound `X-Request-Id` (src/web/serve.js: `/^[A-Za-z0-9._:+/=-]{1,128}$/`),
/// else mint a v4 UUID. Non-deterministic → excluded from parity comparison.
func resolveRequestId(_ head: HTTPRequestHead) -> String {
  if let incoming = head.headers.first(name: "x-request-id"), isValidRequestId(incoming) {
    return incoming
  }
  return mintUUIDv4()
}

private func isValidRequestId(_ s: String) -> Bool {
  let utf8 = s.utf8
  guard (1...128).contains(utf8.count) else { return false }
  for b in utf8 {
    switch b {
    case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
      UInt8(ascii: "0")...UInt8(ascii: "9"):
      continue
    case UInt8(ascii: "."), UInt8(ascii: "_"), UInt8(ascii: ":"), UInt8(ascii: "+"),
      UInt8(ascii: "/"), UInt8(ascii: "="), UInt8(ascii: "-"):
      continue
    default:
      return false
    }
  }
  return true
}

private func mintUUIDv4() -> String {
  var bytes = [UInt8](repeating: 0, count: 16)
  var rng = SystemRandomNumberGenerator()
  for i in 0..<16 { bytes[i] = UInt8.random(in: 0...255, using: &rng) }
  bytes[6] = (bytes[6] & 0x0F) | 0x40  // version 4
  bytes[8] = (bytes[8] & 0x3F) | 0x80  // RFC 4122 variant
  let hex: [UInt8] = Array("0123456789abcdef".utf8)
  var out = [UInt8]()
  out.reserveCapacity(36)
  for (i, b) in bytes.enumerated() {
    if i == 4 || i == 6 || i == 8 || i == 10 { out.append(UInt8(ascii: "-")) }
    out.append(hex[Int(b >> 4)])
    out.append(hex[Int(b & 0xF)])
  }
  return String(decoding: out, as: UTF8.self)
}

/// Writes a `WebResponse` over the async channel, applying the cross-cutting
/// header layer + the `hashable`→ETag→304 path. Returns nothing; the caller
/// owns keep-alive.
func writeWeb(
  _ response: WebResponse, to head: HTTPRequestHead, keepAlive: Bool,
  outbound: NIOAsyncChannelOutboundWriter<HTTPServerResponsePart>
) async throws {
  var headers = HTTPHeaders()
  var status = response.status
  var body = response.body
  var emitEntity = true  // false on 304 → no content-type/length/body

  if response.hashable {
    let etag = "\"\(sha256HexLower(response.body).prefix(16))\""
    headers.add(name: "etag", value: etag)
    if let inm = head.headers.first(name: "if-none-match"), matchesIfNoneMatch(inm, etag) {
      status = .notModified
      body = []
      emitEntity = false
    }
  }
  if emitEntity {
    headers.add(name: "content-type", value: response.contentType)
    headers.add(name: "content-length", value: String(body.count))
  }
  if let cacheControl = response.cacheControl {
    headers.add(name: "cache-control", value: cacheControl)
  }
  for (name, value) in WebConst.securityHeaders { headers.add(name: name, value: value) }
  headers.add(name: "link", value: WebConst.discoveryLinks)
  headers.add(name: "vary", value: "Accept")
  headers.add(name: "x-request-id", value: resolveRequestId(head))
  headers.add(name: "connection", value: keepAlive ? "keep-alive" : "close")

  try await outbound.write(
    .head(HTTPResponseHead(version: head.version, status: status, headers: headers)))
  if !body.isEmpty {
    try await outbound.write(.body(.byteBuffer(ByteBuffer(bytes: body))))
  }
  try await outbound.write(.end(nil))
}

// Ordered JSON for the content pipeline (RFC 0004 D-0004-1).
//
// JSON.parse-equivalent semantics, hand-rolled because shipped targets
// carry no Foundation:
//   - objects preserve INSERTION ORDER; duplicate keys keep the value of
//     the LAST occurrence at the FIRST occurrence's position (verified
//     ECMAScript behavior);
//   - \uXXXX escapes combine surrogate pairs; UNPAIRED surrogates decode
//     to U+FFFD (a JS string holding a lone surrogate becomes U+FFFD at
//     every UTF-8 boundary this pipeline crosses — pinned by the RFC 0004
//     phase-1 audit);
//   - raw control characters in strings, malformed numbers, trailing
//     garbage: errors, exactly like JSON.parse;
//   - container depth is capped (recursive descent): the safeJson wrapper
//     uses 64 (mirroring src/content/safe-json.js's freeze limit → nil),
//     page parsing uses a generous cap and falls back to JS per-call.

public enum JsonValue {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JsonValue])
  case object(JsonObject)

  public var isTruthy: Bool {
    switch self {
    case .null: return false
    case .bool(let b): return b
    case .number(let n): return n != 0 && !n.isNaN
    case .string(let s): return !s.isEmpty
    case .array, .object: return true
    }
  }

  public var asString: String? {
    if case .string(let s) = self { return s }
    return nil
  }

  public var asNumber: Double? {
    if case .number(let n) = self { return n }
    return nil
  }

  public var asArray: [JsonValue]? {
    if case .array(let a) = self { return a }
    return nil
  }

  public var asObject: JsonObject? {
    if case .object(let o) = self { return o }
    return nil
  }

  /// ECMAScript ToString for the renderer default branches
  /// (`String(node.code)`-style coercions): arrays join element coercions
  /// with ',' (null/undefined → ''), objects are "[object Object]".
  public var jsStringCoercion: String {
    switch self {
    case .null: return "null"
    case .bool(let b): return b ? "true" : "false"
    case .number(let n): return Json.ecmaNumberToString(n)
    case .string(let s): return s
    case .object: return "[object Object]"
    case .array(let items):
      return items.map { item -> String in
        if case .null = item { return "" }
        return item.jsStringCoercion
      }.joined(separator: ",")
    }
  }
}

/// Insertion-ordered object with O(1) key lookup and ECMAScript
/// duplicate-key semantics.
public struct JsonObject {
  public private(set) var keys: [String] = []
  private var values: [JsonValue] = []
  private var index: [String: Int] = [:]

  public init() {}

  public subscript(key: String) -> JsonValue? {
    guard let i = index[key] else { return nil }
    return values[i]
  }

  public var count: Int { keys.count }

  /// Ordered (key, value) pairs — Object.entries order.
  public var entries: [(key: String, value: JsonValue)] {
    var out: [(String, JsonValue)] = []
    out.reserveCapacity(keys.count)
    for (i, key) in keys.enumerated() { out.append((key, values[i])) }
    return out
  }

  public mutating func set(_ key: String, _ value: JsonValue) {
    if let existing = index[key] {
      values[existing] = value // last value wins, first position kept
    } else {
      index[key] = keys.count
      keys.append(key)
      values.append(value)
    }
  }
}

public enum JsonError: Error {
  case syntax(String)
  case depthExceeded
}

public enum Json {
  /// JSON.parse equivalent. `maxContainerDepth` counts nesting of
  /// arrays/objects with the root container at depth 0.
  public static func parse(_ utf8: [UInt8], maxContainerDepth: Int = 512) throws -> JsonValue {
    var parser = Parser(bytes: utf8, maxDepth: maxContainerDepth)
    let value = try parser.parseValue(depth: 0)
    parser.skipWhitespace()
    guard parser.atEnd else { throw JsonError.syntax("trailing characters") }
    return value
  }

  /// src/content/safe-json.js equivalent: parse-or-nil with the freeze
  /// walk's depth-64 container limit (deeper → nil, like the thrown
  /// ParseError there). Non-string/empty inputs are the caller's concern.
  public static func safeJson(_ utf8: [UInt8]) -> JsonValue? {
    try? parse(utf8, maxContainerDepth: 64)
  }

  /// ECMAScript Number::toString(10) — the integral fast path plus the
  /// spec's positional/exponent formatting over shortest-round-trip
  /// digits (Swift's Double description supplies the digits).
  public static func ecmaNumberToString(_ value: Double) -> String {
    if value.isNaN { return "NaN" }
    if value == 0 { return "0" }
    if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
    let negative = value < 0
    let magnitude = abs(value)
    if magnitude < 9_007_199_254_740_992, magnitude.rounded(.down) == magnitude {
      // Exact-integer range (< 2^53): plain digits. Larger integral values
      // (< 1e21) format through the general k ≤ n ≤ 21 branch below.
      let digits = String(UInt64(magnitude))
      return negative ? "-" + digits : digits
    }
    let (s, n) = shortestDigits(magnitude)
    let k = s.count
    var out: String
    if k <= n, n <= 21 {
      out = s + String(repeating: "0", count: n - k)
    } else if 0 < n, n <= 21 {
      let head = String(s.prefix(n))
      let tail = String(s.dropFirst(n))
      out = head + "." + tail
    } else if -6 < n, n <= 0 {
      out = "0." + String(repeating: "0", count: -n) + s
    } else {
      let mantissa = k == 1 ? s : "\(s.prefix(1)).\(s.dropFirst(1))"
      let exponent = n - 1
      out = "\(mantissa)e\(exponent >= 0 ? "+" : "-")\(abs(exponent))"
    }
    return negative ? "-" + out : out
  }

  /// Decompose a positive double into (shortest decimal digits, decimal
  /// exponent n) such that value = 0.s × 10^n — derived from Swift's
  /// shortest-round-trip `description`.
  private static func shortestDigits(_ magnitude: Double) -> (digits: String, n: Int) {
    let text = magnitude.description // e.g. "1.5", "1e-07", "1.234e+18"
    var mantissa = text
    var exp10 = 0
    if let eIndex = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
      mantissa = String(text[..<eIndex])
      exp10 = Int(text[text.index(after: eIndex)...]) ?? 0
    }
    var intPart = mantissa
    var fracPart = ""
    if let dot = mantissa.firstIndex(of: ".") {
      intPart = String(mantissa[..<dot])
      fracPart = String(mantissa[mantissa.index(after: dot)...])
    }
    var digits = intPart + fracPart
    // n positions the decimal point: value = 0.digits × 10^n
    var n = intPart.count + exp10
    // Strip leading zeros (adjusting n), then trailing zeros.
    var leading = 0
    for ch in digits {
      if ch == "0" { leading += 1 } else { break }
    }
    if leading > 0 {
      digits = String(digits.dropFirst(leading))
      n -= leading
    }
    while digits.hasSuffix("0") { digits = String(digits.dropLast()) }
    if digits.isEmpty { digits = "0"; n = 1 }
    return (digits, n)
  }
}

private struct Parser {
  let bytes: [UInt8]
  let maxDepth: Int
  var pos = 0

  init(bytes: [UInt8], maxDepth: Int) {
    self.bytes = bytes
    self.maxDepth = maxDepth
  }

  var atEnd: Bool { pos >= bytes.count }

  mutating func skipWhitespace() {
    while pos < bytes.count {
      switch bytes[pos] {
      case 0x20, 0x09, 0x0A, 0x0D: pos += 1
      default: return
      }
    }
  }

  mutating func parseValue(depth: Int) throws -> JsonValue {
    skipWhitespace()
    guard pos < bytes.count else { throw JsonError.syntax("unexpected end") }
    switch bytes[pos] {
    case UInt8(ascii: "{"):
      guard depth <= maxDepth else { throw JsonError.depthExceeded }
      return try parseObject(depth: depth)
    case UInt8(ascii: "["):
      guard depth <= maxDepth else { throw JsonError.depthExceeded }
      return try parseArray(depth: depth)
    case UInt8(ascii: "\""):
      return .string(try parseString())
    case UInt8(ascii: "t"):
      try expect("true")
      return .bool(true)
    case UInt8(ascii: "f"):
      try expect("false")
      return .bool(false)
    case UInt8(ascii: "n"):
      try expect("null")
      return .null
    default:
      return .number(try parseNumber())
    }
  }

  mutating func expect(_ literal: String) throws {
    for ch in literal.utf8 {
      guard pos < bytes.count, bytes[pos] == ch else { throw JsonError.syntax("invalid literal") }
      pos += 1
    }
  }

  mutating func parseObject(depth: Int) throws -> JsonValue {
    pos += 1 // {
    var object = JsonObject()
    skipWhitespace()
    if pos < bytes.count, bytes[pos] == UInt8(ascii: "}") {
      pos += 1
      return .object(object)
    }
    while true {
      skipWhitespace()
      guard pos < bytes.count, bytes[pos] == UInt8(ascii: "\"") else {
        throw JsonError.syntax("expected object key")
      }
      let key = try parseString()
      skipWhitespace()
      guard pos < bytes.count, bytes[pos] == UInt8(ascii: ":") else {
        throw JsonError.syntax("expected ':'")
      }
      pos += 1
      object.set(key, try parseValue(depth: depth + 1))
      skipWhitespace()
      guard pos < bytes.count else { throw JsonError.syntax("unterminated object") }
      if bytes[pos] == UInt8(ascii: ",") {
        pos += 1
        continue
      }
      if bytes[pos] == UInt8(ascii: "}") {
        pos += 1
        return .object(object)
      }
      throw JsonError.syntax("expected ',' or '}'")
    }
  }

  mutating func parseArray(depth: Int) throws -> JsonValue {
    pos += 1 // [
    var items: [JsonValue] = []
    skipWhitespace()
    if pos < bytes.count, bytes[pos] == UInt8(ascii: "]") {
      pos += 1
      return .array(items)
    }
    while true {
      items.append(try parseValue(depth: depth + 1))
      skipWhitespace()
      guard pos < bytes.count else { throw JsonError.syntax("unterminated array") }
      if bytes[pos] == UInt8(ascii: ",") {
        pos += 1
        continue
      }
      if bytes[pos] == UInt8(ascii: "]") {
        pos += 1
        return .array(items)
      }
      throw JsonError.syntax("expected ',' or ']'")
    }
  }

  mutating func parseString() throws -> String {
    pos += 1 // opening quote
    // Fast path: scan for the closing quote; if the span has no escapes,
    // no raw controls and pure ASCII-or-valid-UTF-8 passthrough bytes, the
    // string is one decode of the slice (input crossed a JS UTF-8 boundary
    // and is well-formed).
    let start = pos
    while pos < bytes.count {
      let byte = bytes[pos]
      if byte == UInt8(ascii: "\"") {
        let slice = bytes[start..<pos]
        pos += 1
        return String(decoding: slice, as: UTF8.self)
      }
      if byte == UInt8(ascii: "\\") { break }
      if byte < 0x20 { throw JsonError.syntax("raw control character in string") }
      pos += 1
    }
    guard pos < bytes.count else { throw JsonError.syntax("unterminated string") }

    // Slow path: escapes present. Build UTF-8 bytes directly, decode once.
    var out = [UInt8]()
    out.reserveCapacity((pos - start) + 16)
    out.append(contentsOf: bytes[start..<pos])
    while true {
      guard pos < bytes.count else { throw JsonError.syntax("unterminated string") }
      let byte = bytes[pos]
      if byte == UInt8(ascii: "\"") {
        pos += 1
        return String(decoding: out, as: UTF8.self)
      }
      if byte == UInt8(ascii: "\\") {
        pos += 1
        guard pos < bytes.count else { throw JsonError.syntax("dangling escape") }
        switch bytes[pos] {
        case UInt8(ascii: "\""): out.append(UInt8(ascii: "\"")); pos += 1
        case UInt8(ascii: "\\"): out.append(UInt8(ascii: "\\")); pos += 1
        case UInt8(ascii: "/"): out.append(UInt8(ascii: "/")); pos += 1
        case UInt8(ascii: "b"): out.append(0x08); pos += 1
        case UInt8(ascii: "f"): out.append(0x0C); pos += 1
        case UInt8(ascii: "n"): out.append(UInt8(ascii: "\n")); pos += 1
        case UInt8(ascii: "r"): out.append(UInt8(ascii: "\r")); pos += 1
        case UInt8(ascii: "t"): out.append(UInt8(ascii: "\t")); pos += 1
        case UInt8(ascii: "u"):
          pos += 1
          let unit = try parseHex4()
          if unit >= 0xD800, unit <= 0xDBFF {
            // High surrogate: combine with a following \uDC00-\uDFFF.
            if pos + 1 < bytes.count, bytes[pos] == UInt8(ascii: "\\"),
              bytes[pos + 1] == UInt8(ascii: "u") {
              let savedPos = pos
              pos += 2
              let low = try parseHex4()
              if low >= 0xDC00, low <= 0xDFFF {
                let combined = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
                appendScalar(UInt32(combined), to: &out)
              } else {
                // Lone high surrogate; the second escape stands alone.
                appendScalar(0xFFFD, to: &out)
                pos = savedPos
              }
            } else {
              appendScalar(0xFFFD, to: &out)
            }
          } else if unit >= 0xDC00, unit <= 0xDFFF {
            appendScalar(0xFFFD, to: &out) // lone low surrogate
          } else {
            appendScalar(UInt32(unit), to: &out)
          }
        default:
          throw JsonError.syntax("invalid escape")
        }
        continue
      }
      if byte < 0x20 { throw JsonError.syntax("raw control character in string") }
      out.append(byte)
      pos += 1
    }
  }

  /// UTF-8-encode one scalar into `out` (callers pass valid non-surrogate
  /// values; surrogates were already replaced with U+FFFD).
  func appendScalar(_ value: UInt32, to out: inout [UInt8]) {
    if value < 0x80 {
      out.append(UInt8(value))
    } else if value < 0x800 {
      out.append(UInt8(0xC0 | (value >> 6)))
      out.append(UInt8(0x80 | (value & 0x3F)))
    } else if value < 0x10000 {
      out.append(UInt8(0xE0 | (value >> 12)))
      out.append(UInt8(0x80 | ((value >> 6) & 0x3F)))
      out.append(UInt8(0x80 | (value & 0x3F)))
    } else {
      out.append(UInt8(0xF0 | (value >> 18)))
      out.append(UInt8(0x80 | ((value >> 12) & 0x3F)))
      out.append(UInt8(0x80 | ((value >> 6) & 0x3F)))
      out.append(UInt8(0x80 | (value & 0x3F)))
    }
  }

  mutating func parseHex4() throws -> Int {
    guard pos + 4 <= bytes.count else { throw JsonError.syntax("truncated \\u escape") }
    var value = 0
    for i in 0..<4 {
      let b = bytes[pos + i]
      let digit: Int
      switch b {
      case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = Int(b - UInt8(ascii: "0"))
      case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = Int(b - UInt8(ascii: "a")) + 10
      case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = Int(b - UInt8(ascii: "A")) + 10
      default: throw JsonError.syntax("invalid \\u escape")
      }
      value = value * 16 + digit
    }
    pos += 4
    return value
  }

  mutating func parseNumber() throws -> Double {
    let start = pos
    if pos < bytes.count, bytes[pos] == UInt8(ascii: "-") { pos += 1 }
    // Integer part: 0 | [1-9][0-9]*
    guard pos < bytes.count else { throw JsonError.syntax("truncated number") }
    if bytes[pos] == UInt8(ascii: "0") {
      pos += 1
    } else if bytes[pos] >= UInt8(ascii: "1"), bytes[pos] <= UInt8(ascii: "9") {
      while pos < bytes.count, bytes[pos] >= UInt8(ascii: "0"), bytes[pos] <= UInt8(ascii: "9") { pos += 1 }
    } else {
      throw JsonError.syntax("invalid number")
    }
    if pos < bytes.count, bytes[pos] == UInt8(ascii: ".") {
      pos += 1
      let fracStart = pos
      while pos < bytes.count, bytes[pos] >= UInt8(ascii: "0"), bytes[pos] <= UInt8(ascii: "9") { pos += 1 }
      guard pos > fracStart else { throw JsonError.syntax("invalid number fraction") }
    }
    if pos < bytes.count, bytes[pos] == UInt8(ascii: "e") || bytes[pos] == UInt8(ascii: "E") {
      pos += 1
      if pos < bytes.count, bytes[pos] == UInt8(ascii: "+") || bytes[pos] == UInt8(ascii: "-") { pos += 1 }
      let expStart = pos
      while pos < bytes.count, bytes[pos] >= UInt8(ascii: "0"), bytes[pos] <= UInt8(ascii: "9") { pos += 1 }
      guard pos > expStart else { throw JsonError.syntax("invalid number exponent") }
    }
    let lexeme = String(decoding: bytes[start..<pos], as: UTF8.self)
    guard let value = Double(lexeme) else { throw JsonError.syntax("unparseable number") }
    return value
  }
}

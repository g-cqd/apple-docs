// Port of src/lib/yaml.js toFrontMatter — flat YAML front matter with the
// exact quoting rules (normative JS until the phase-5 kill).

public enum FrontMatter {
  public enum Value {
    case scalar(String)
    case list([String])
  }

  /// Ordered fields; nil values are skipped (the `value == null` guard —
  /// compactObject upstream already drops them, this keeps the seam safe).
  public static func render(_ fields: [(key: String, value: Value?)]) -> String {
    var lines = ["---"]
    for (key, value) in fields {
      guard let value else { continue }
      switch value {
      case .scalar(let s):
        lines.append("\(key): \(quoteIfNeeded(s))")
      case .list(let items):
        lines.append("\(key): [\(items.map(quoteIfNeeded).joined(separator: ", "))]")
      }
    }
    lines.append("---")
    return lines.joined(separator: "\n")
  }

  static func quoteIfNeeded(_ s: String) -> String {
    if needsQuoting(s) {
      var escaped = ""
      for ch in s.unicodeScalars {
        if ch == "\\" { escaped += "\\\\" } else if ch == "\"" { escaped += "\\\"" } else { escaped.unicodeScalars.append(ch) }
      }
      return "\"\(escaped)\""
    }
    return s
  }

  private static func needsQuoting(_ s: String) -> Bool {
    var s = s
    return s.withUTF8 { needsQuotingBytes(UnsafeBufferPointer(rebasing: $0[...])) }
  }

  /// yaml.js quoting predicate over raw UTF-8 (all trigger chars are ASCII,
  /// so byte scanning is exact).
  public static func needsQuotingBytes<C: Collection>(_ bytes: C) -> Bool where C.Element == UInt8 {
    if bytes.isEmpty { return true }
    if equalsAscii(bytes, "true") || equalsAscii(bytes, "false") || equalsAscii(bytes, "null") {
      return true
    }
    var allDigitsDots = true
    for byte in bytes {
      switch byte {
      case UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "."):
        continue
      default:
        allDigitsDots = false
      }
      if !allDigitsDots { break }
    }
    if allDigitsDots { return true }
    for byte in bytes {
      switch byte {
      case UInt8(ascii: ":"), UInt8(ascii: "{"), UInt8(ascii: "}"), UInt8(ascii: "["),
        UInt8(ascii: "]"), UInt8(ascii: ","), UInt8(ascii: "&"), UInt8(ascii: "*"),
        UInt8(ascii: "?"), UInt8(ascii: "|"), UInt8(ascii: ">"), UInt8(ascii: "!"),
        UInt8(ascii: "%"), UInt8(ascii: "#"), UInt8(ascii: "@"), UInt8(ascii: "`"),
        UInt8(ascii: "\""), UInt8(ascii: "'"), 0x0A:
        return true
      default:
        continue
      }
    }
    return false
  }

  private static func equalsAscii<C: Collection>(_ bytes: C, _ literal: StaticString) -> Bool
  where C.Element == UInt8 {
    guard bytes.count == literal.utf8CodeUnitCount else { return false }
    var i = 0
    for byte in bytes {
      if byte != literal.utf8Start[i] { return false }
      i += 1
    }
    return true
  }
}

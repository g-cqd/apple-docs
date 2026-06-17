public enum FrontMatter {
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

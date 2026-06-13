// Minimal hand-framed JSON writer (no Foundation). Escaping matches
// JSON.stringify: ", \, the short escapes \b\f\n\r\t, and \u00XX for other
// control bytes; everything else (incl. UTF-8 non-ASCII) passes through.
// Commas between object members / array elements are inserted automatically.

struct JSONWriter {
  var bytes: [UInt8] = []
  private var hasContent: [Bool] = []  // per open container
  private var afterKey = false

  private mutating func beforeValue() {
    if afterKey { afterKey = false; return }
    if let last = hasContent.last, last { bytes.append(UInt8(ascii: ",")) }
    if !hasContent.isEmpty { hasContent[hasContent.count - 1] = true }
  }

  mutating func openObject() {
    beforeValue()
    bytes.append(UInt8(ascii: "{"))
    hasContent.append(false)
  }
  mutating func closeObject() {
    bytes.append(UInt8(ascii: "}"))
    hasContent.removeLast()
  }
  mutating func openArray() {
    beforeValue()
    bytes.append(UInt8(ascii: "["))
    hasContent.append(false)
  }
  mutating func closeArray() {
    bytes.append(UInt8(ascii: "]"))
    hasContent.removeLast()
  }

  mutating func key(_ k: String) {
    if let last = hasContent.last, last { bytes.append(UInt8(ascii: ",")) }
    if !hasContent.isEmpty { hasContent[hasContent.count - 1] = true }
    writeString(k)
    bytes.append(UInt8(ascii: ":"))
    afterKey = true
  }

  mutating func string(_ s: String) {
    beforeValue()
    writeString(s)
  }
  mutating func stringOrNull(_ s: String?) {
    beforeValue()
    if let s { writeString(s) } else { bytes.append(contentsOf: "null".utf8) }
  }
  mutating func int(_ n: Int) {
    beforeValue()
    bytes.append(contentsOf: String(n).utf8)
  }
  mutating func bool(_ b: Bool) {
    beforeValue()
    bytes.append(contentsOf: (b ? "true" : "false").utf8)
  }
  mutating func raw(_ s: String) {
    beforeValue()
    bytes.append(contentsOf: s.utf8)
  }
  /// Emits the raw JSON string verbatim (a stored platforms_json array), or []
  /// when nil — JSON.stringify(JSON.parse(x)) is identity for the compact JSON
  /// the pipeline stores.
  mutating func rawOrEmptyArray(_ s: String?) {
    beforeValue()
    if let s { bytes.append(contentsOf: s.utf8) } else { bytes.append(contentsOf: "[]".utf8) }
  }

  private mutating func writeString(_ s: String) {
    bytes.append(UInt8(ascii: "\""))
    let backslash = UInt8(ascii: "\\")
    for b in s.utf8 {
      switch b {
      case 0x22: bytes.append(backslash); bytes.append(0x22)
      case 0x5C: bytes.append(backslash); bytes.append(0x5C)
      case 0x08: bytes.append(backslash); bytes.append(UInt8(ascii: "b"))
      case 0x0C: bytes.append(backslash); bytes.append(UInt8(ascii: "f"))
      case 0x0A: bytes.append(backslash); bytes.append(UInt8(ascii: "n"))
      case 0x0D: bytes.append(backslash); bytes.append(UInt8(ascii: "r"))
      case 0x09: bytes.append(backslash); bytes.append(UInt8(ascii: "t"))
      case 0..<0x20:
        bytes.append(backslash)
        bytes.append(UInt8(ascii: "u"))
        bytes.append(UInt8(ascii: "0"))
        bytes.append(UInt8(ascii: "0"))
        bytes.append(hexDigit(b >> 4))
        bytes.append(hexDigit(b & 0xF))
      default:
        bytes.append(b)
      }
    }
    bytes.append(UInt8(ascii: "\""))
  }

  private func hexDigit(_ v: UInt8) -> UInt8 {
    v < 10 ? UInt8(ascii: "0") + v : UInt8(ascii: "a") + (v - 10)
  }
}

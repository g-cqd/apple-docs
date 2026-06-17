// JavaScript string-semantics helpers shared by the content renderers.
// Each mirrors a specific JS construct — change both sides together.
//
// Implementation note: everything operates on UTF-8 BYTES (the dylib's
// boundary representation) — '\n' and all ASCII classes are single bytes
// (continuation bytes are ≥ 0x80, so byte scans can't tear scalars), and
// the JS whitespace set is decoded per scalar only on the rare ≥ 0x80
// path. Scalar-by-scalar String building measured ~100× slower.

public import ADBase
public import ADEmbed
public import ADFUnicode

public enum JsString {
  @inline(__always)
  static func isAsciiJsWhitespace(_ byte: UInt8) -> Bool {
    byte == 0x20 || (byte >= 0x09 && byte <= 0x0D)
  }

  /// Decodes the scalar starting at `i` (caller guarantees `bytes[i] >= 0x80`
  /// begins a well-formed sequence — content crossed a JS UTF-8 boundary).
  @inline(__always)
  static func scalarAt(_ bytes: [UInt8], _ i: Int) -> (value: UInt32, width: Int) {
    let b0 = bytes[i]
    if b0 < 0x80 { return (UInt32(b0), 1) }
    if b0 & 0xE0 == 0xC0, i + 1 < bytes.count {
      return ((UInt32(b0 & 0x1F) << 6) | UInt32(bytes[i + 1] & 0x3F), 2)
    }
    if b0 & 0xF0 == 0xE0, i + 2 < bytes.count {
      return (
        (UInt32(b0 & 0x0F) << 12) | (UInt32(bytes[i + 1] & 0x3F) << 6)
          | UInt32(bytes[i + 2] & 0x3F), 3
      )
    }
    if b0 & 0xF8 == 0xF0, i + 3 < bytes.count {
      return (
        (UInt32(b0 & 0x07) << 18) | (UInt32(bytes[i + 1] & 0x3F) << 12)
          | (UInt32(bytes[i + 2] & 0x3F) << 6) | UInt32(bytes[i + 3] & 0x3F), 4
      )
    }
    return (0xFFFD, 1)
  }

  @inline(__always)
  static func whitespaceWidth(_ bytes: [UInt8], _ i: Int) -> Int? {
    let byte = bytes[i]
    if byte < 0x80 { return isAsciiJsWhitespace(byte) ? 1 : nil }
    let (value, width) = scalarAt(bytes, i)
    return UnicodeSets.isJsWhitespace(value) ? width : nil
  }

  /// JS `String.prototype.trim()`: strips WhiteSpace ∪ LineTerminator,
  /// which is exactly the engine-derived jsWhitespace set (incl. U+FEFF).
  public static func trim(_ text: String) -> String {
    let bytes = Array(text.utf8)
    let (start, end) = trimBounds(bytes)
    if start == 0, end == bytes.count { return text }
    return String(decoding: bytes[start..<end], as: UTF8.self)
  }

  static func trimBounds(_ bytes: [UInt8]) -> (Int, Int) {
    var start = 0
    while start < bytes.count {
      guard let width = whitespaceWidth(bytes, start) else { break }
      start += width
    }
    var end = bytes.count
    while end > start {
      // Find the start of the scalar ending at `end`.
      var scalarStart = end - 1
      while scalarStart > start, bytes[scalarStart] & 0xC0 == 0x80 { scalarStart -= 1 }
      guard let width = whitespaceWidth(bytes, scalarStart), scalarStart + width == end else { break }
      end = scalarStart
    }
    return (start, end)
  }

  /// `.replace(/\n{3,}/g, '\n\n')` — collapses runs of 3+ newlines to two.
  public static func collapseBlankRuns(_ text: String) -> String {
    let bytes = Array(text.utf8)
    var out = [UInt8]()
    out.reserveCapacity(bytes.count)
    var run = 0
    for byte in bytes {
      if byte == 0x0A {
        run += 1
        continue
      }
      if run > 0 {
        out.append(0x0A)
        if run > 1 { out.append(0x0A) }
        run = 0
      }
      out.append(byte)
    }
    if run > 0 {
      out.append(0x0A)
      if run > 1 { out.append(0x0A) }
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// normalizeParagraphs: trim → split on /\n{2,}/ → each paragraph's
  /// \n+ runs become one space, trimmed → join '\n\n'.
  public static func normalizeParagraphs(_ text: String) -> String {
    let bytes = Array(text.utf8)
    let (start, end) = trimBounds(bytes)
    if start >= end { return "" }
    // Paragraph boundaries: runs of ≥ 2 newlines (whitespace between the
    // newlines does NOT merge runs — /\n{2,}/ is literal).
    var paragraphs: [[UInt8]] = []
    var current = [UInt8]()
    var newlines = 0
    var i = start
    while i < end {
      let byte = bytes[i]
      if byte == 0x0A {
        newlines += 1
        i += 1
        continue
      }
      if newlines >= 2 {
        paragraphs.append(current)
        current = []
      } else if newlines == 1 {
        current.append(0x20)
      }
      newlines = 0
      current.append(byte)
      i += 1
    }
    paragraphs.append(current)
    var out = [UInt8]()
    out.reserveCapacity(end - start)
    for (index, paragraph) in paragraphs.enumerated() {
      if index > 0 {
        out.append(0x0A)
        out.append(0x0A)
      }
      let (ps, pe) = trimBounds(paragraph)
      out.append(contentsOf: paragraph[ps..<pe])
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// `.replace(/\s+/g, ' ')` — jsWhitespace runs become one space.
  public static func collapseWhitespaceRuns(_ text: String) -> String {
    let bytes = Array(text.utf8)
    var out = [UInt8]()
    out.reserveCapacity(bytes.count)
    var i = 0
    var inRun = false
    while i < bytes.count {
      if let width = whitespaceWidth(bytes, i) {
        inRun = true
        i += width
        continue
      }
      if inRun {
        out.append(0x20)
        inRun = false
      }
      out.append(bytes[i])
      i += 1
    }
    if inRun { out.append(0x20) }
    return String(decoding: out, as: UTF8.self)
  }

  /// humanize: `_`→space, then uppercase every `\b\w` match — an ASCII
  /// word char at a word boundary (JS \w and \b are ASCII-only; non-ASCII
  /// bytes are all ≥ 0x80 = non-word).
  public static func humanize(_ text: String) -> String {
    var out = Array(text.utf8)
    var previousIsWord = false
    for i in out.indices {
      var byte = out[i]
      if byte == UInt8(ascii: "_") {
        byte = 0x20
        out[i] = byte
      }
      let isWord =
        (byte >= UInt8(ascii: "a") && byte <= UInt8(ascii: "z"))
        || (byte >= UInt8(ascii: "A") && byte <= UInt8(ascii: "Z"))
        || (byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9")) || byte == UInt8(ascii: "_")
      if isWord, !previousIsWord, byte >= UInt8(ascii: "a"), byte <= UInt8(ascii: "z") {
        out[i] = byte - 0x20
      }
      previousIsWord = isWord
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// JS toLowerCase (full Unicode incl. Final_Sigma) via the engine-derived
  /// tables ADEmbed already carries. Identifier-sized inputs only.
  public static func lowercase(_ text: String) -> String {
    let lowered = CaseFolding.lowercase(Array(text.unicodeScalars))
    var out = ""
    out.unicodeScalars.append(contentsOf: lowered)
    return out
  }
}

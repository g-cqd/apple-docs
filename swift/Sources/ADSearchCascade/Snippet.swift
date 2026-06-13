// Port of src/content/render-snippet.js renderSnippet (RFC 0001 P6 enrichment).
// renderPlainText reuses the validated ADContent.PlainText span renderer; the
// windowing replicates JS string semantics exactly — UTF-16 indices for
// indexOf/slice/length, JsString.lowercase for toLowerCase, JsString.trim for
// trim. ASCII (the Apple-docs common case) is identity; non-ASCII matches via
// the UTF-16 view + JsString. (A window boundary landing mid-surrogate-pair is
// the one known divergence — JS keeps a lone surrogate, Swift cannot.)

import ADContent
import ADStorage

enum Snippet {
  static func render(_ doc: SnippetDoc, query: String, maxLength: Int = 220) -> String {
    let text = renderPlainText(doc)
    if text.isEmpty { return "" }
    let textU16 = Array(text.utf16)

    // terms = query.toLowerCase().split(/\s+/).map(clean).filter(Boolean)
    let terms = splitWhitespace(JsString.lowercase(query)).map(cleanTerm).filter { !$0.isEmpty }
    if terms.isEmpty { return truncate(textU16, maxLength) }

    // hitIndex = terms.map(t => lower.indexOf(t)).filter(>=0).sort()[0]
    let lowerU16 = Array(JsString.lowercase(text).utf16)
    var hitIndex: Int?
    for term in terms {
      if let idx = firstIndex(of: Array(term.utf16), in: lowerU16) {
        if hitIndex == nil || idx < hitIndex! { hitIndex = idx }
      }
    }
    guard let hit = hitIndex else { return truncate(textU16, maxLength) }

    // windowStart = max(0, hit - Math.floor(maxLength * 0.35)); same IEEE op as JS.
    let windowStart = max(0, hit - Int((Double(maxLength) * 0.35).rounded(.down)))
    let windowEnd = min(textU16.count, windowStart + maxLength)
    let slice = JsString.trim(u16String(Array(textU16[windowStart..<windowEnd])))
    let prefix = windowStart > 0 ? "..." : ""
    let suffix = windowEnd < textU16.count ? "..." : ""
    return prefix + slice + suffix
  }

  // MARK: - renderPlainText (reuse ADContent.PlainText via spans)

  private static func renderPlainText(_ doc: SnippetDoc) -> String {
    var buf: [UInt8] = []
    buf.reserveCapacity(512)
    func record(_ s: String?) -> Range<Int>? {
      guard let s else { return nil }
      let start = buf.count
      buf.append(contentsOf: s.utf8)
      return start..<buf.count
    }
    let titleR = record(doc.title)
    let absR = record(doc.abstractText)
    let declR = record(doc.declarationText)
    let headR = record(doc.headings)
    let secR = doc.sections.map { (record($0.heading), record($0.contentText), $0.sortOrder) }

    var out: [UInt8] = []
    buf.withUnsafeBufferPointer { bp in
      func span(_ r: Range<Int>?) -> ByteSpan? {
        guard let r, let base = bp.baseAddress else { return nil }
        return ByteSpan(start: UnsafeRawPointer(base + r.lowerBound), count: r.count)
      }
      let empty = ByteSpan(start: nil, count: 0)
      let document = PlainTextSpans(
        title: span(titleR), abstractText: span(absR), declarationText: span(declR),
        headings: span(headR))
      let sections = secR.map {
        PlainSectionSpans(heading: span($0.0), text: span($0.1) ?? empty, sortOrder: $0.2)
      }
      var w = ByteWriter(capacity: 512)
      PlainText.render(document: document, sections: sections, w: &w, out: &out)
    }
    return String(decoding: out, as: UTF8.self)
  }

  private static func truncate(_ textU16: [UInt16], _ maxLength: Int) -> String {
    if textU16.count <= maxLength { return u16String(textU16) }
    let cut = Array(textU16[0..<max(0, maxLength - 3)])
    return JsString.trim(u16String(cut)) + "..."
  }

  // MARK: - JS string-semantics helpers

  private static func u16String(_ units: [UInt16]) -> String {
    String(decoding: units, as: UTF16.self)
  }

  private static func firstIndex(of needle: [UInt16], in haystack: [UInt16]) -> Int? {
    if needle.isEmpty { return 0 }
    if needle.count > haystack.count { return nil }
    for start in 0...(haystack.count - needle.count) {
      var matched = true
      for j in 0..<needle.count where haystack[start + j] != needle[j] {
        matched = false
        break
      }
      if matched { return start }
    }
    return nil
  }

  /// JS `String.split(/\s+/)` — splits on maximal whitespace runs, keeping empty
  /// tokens at leading/trailing boundaries (dropped later by filter(Boolean)).
  private static func splitWhitespace(_ s: String) -> [String] {
    let scalars = Array(s.unicodeScalars)
    var result: [String] = []
    var current = String.UnicodeScalarView()
    var i = 0
    while i < scalars.count {
      if isJsWhitespace(scalars[i]) {
        result.append(String(current))
        current = String.UnicodeScalarView()
        while i < scalars.count, isJsWhitespace(scalars[i]) { i += 1 }
      } else {
        current.append(scalars[i])
        i += 1
      }
    }
    result.append(String(current))
    return result
  }

  /// JS `term.replace(/[^\p{L}\p{N}_-]+/gu, '')` — keep letters, numbers, `_`, `-`.
  private static func cleanTerm(_ term: String) -> String {
    var out = String.UnicodeScalarView()
    for s in term.unicodeScalars where s == "_" || s == "-" || isLetterOrNumber(s) {
      out.append(s)
    }
    return String(out)
  }

  private static func isLetterOrNumber(_ s: Unicode.Scalar) -> Bool {
    switch s.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
      .decimalNumber, .letterNumber, .otherNumber:
      return true
    default:
      return false
    }
  }

  private static func isJsWhitespace(_ s: Unicode.Scalar) -> Bool {
    switch s.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029,
      0x202F, 0x205F, 0x3000, 0xFEFF:
      return true
    default:
      return false
    }
  }
}

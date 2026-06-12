// Byte writer for the tape renderers (RFC 0004 §6b): everything renders
// into ONE growing [UInt8]; the JS string transforms (trim, \s+→' ',
// \n→' ') run IN PLACE over a marked suffix, so no intermediate Strings
// exist anywhere on the hot path.

import ADBase
import ADEmbed

public typealias ByteSpan = UnsafeRawBufferPointer

public struct ByteWriter {
  public var bytes: [UInt8] = []

  public init(capacity: Int = 4096) {
    bytes.reserveCapacity(capacity)
  }

  @inlinable public var count: Int { bytes.count }

  @inlinable public mutating func removeAll() {
    bytes.removeAll(keepingCapacity: true)
  }

  @inlinable public mutating func truncate(to mark: Int) {
    bytes.removeLast(bytes.count - mark)
  }

  @inlinable public mutating func append(_ byte: UInt8) {
    bytes.append(byte)
  }

  public mutating func append(_ literal: StaticString) {
    literal.withUTF8Buffer { bytes.append(contentsOf: $0) }
  }

  public mutating func append(_ string: String) {
    var string = string
    string.withUTF8 { bytes.append(contentsOf: $0) }
  }

  @inlinable public mutating func append(span: ByteSpan) {
    bytes.append(contentsOf: span.bindMemory(to: UInt8.self))
  }

  public mutating func append(tape: JsonTape, string index: Int) {
    tape.withStringBytes(index) { span in
      bytes.append(contentsOf: span.bindMemory(to: UInt8.self))
    }
  }

  /// `${value}` template coercion of an arbitrary tape node.
  public mutating func appendCoercion(tape: JsonTape, _ index: Int) {
    if tape.kind(index) == .string {
      append(tape: tape, string: index)
    } else {
      append(tape.jsStringCoercion(index))
    }
  }

  // MARK: - In-place JS transforms over a marked suffix

  /// JS trim() over bytes[mark...]: drops leading/trailing jsWhitespace.
  public mutating func trim(since mark: Int) {
    let (start, end) = ByteOps.trimRange(bytes, mark, bytes.count)
    if end < bytes.count { bytes.removeLast(bytes.count - end) }
    if start > mark {
      bytes.removeSubrange(mark..<start)
    }
  }

  /// `.replace(/\s+/g, ' ')` over bytes[mark...].
  public mutating func collapseWhitespace(since mark: Int) {
    var out = mark
    var i = mark
    var inRun = false
    let n = bytes.count
    while i < n {
      if let width = ByteOps.whitespaceWidth(bytes, i, n) {
        inRun = true
        i += width
        continue
      }
      if inRun {
        bytes[out] = 0x20
        out += 1
        inRun = false
      }
      bytes[out] = bytes[i]
      out += 1
      i += 1
    }
    if inRun {
      bytes[out] = 0x20
      out += 1
    }
    bytes.removeLast(n - out)
  }

  /// `.replace(/\n/g, ' ')` over bytes[mark...].
  public mutating func newlinesToSpaces(since mark: Int) {
    for i in mark..<bytes.count where bytes[i] == 0x0A {
      bytes[i] = 0x20
    }
  }

  /// normalizeParagraphs over a raw input span, appended to the writer
  /// (render-markdown.js:142-149 semantics).
  public mutating func appendNormalizedParagraphs(_ span: ByteSpan) {
    let input = span.bindMemory(to: UInt8.self)
    let (start, end) = ByteOps.trimRange(input, 0, input.count)
    if start >= end { return }
    let base = bytes.count
    var newlines = 0
    var pendingBreak = false
    var paragraphStart = bytes.count
    func closeParagraph() {
      let (ps, pe) = ByteOps.trimRange(bytes, paragraphStart, bytes.count)
      if pe < bytes.count { bytes.removeLast(bytes.count - pe) }
      if ps > paragraphStart { bytes.removeSubrange(paragraphStart..<ps) }
    }
    var i = start
    while i < end {
      let byte = input[i]
      if byte == 0x0A {
        newlines += 1
        i += 1
        continue
      }
      if newlines >= 2 {
        closeParagraph()
        pendingBreak = true
      } else if newlines == 1 {
        bytes.append(0x20)
      }
      newlines = 0
      if pendingBreak {
        bytes.append(0x0A)
        bytes.append(0x0A)
        paragraphStart = bytes.count
        pendingBreak = false
      }
      bytes.append(byte)
      i += 1
    }
    closeParagraph()
    _ = base
  }

  /// Trimmed JS-trim append of a raw span (no intermediate copy).
  public mutating func appendTrimmed(_ span: ByteSpan) {
    let input = span.bindMemory(to: UInt8.self)
    let (start, end) = ByteOps.trimRange(input, 0, input.count)
    if start < end {
      bytes.append(contentsOf: input[start..<end])
    }
  }
}

/// Range-based byte helpers shared by the writer and the finisher.
public enum ByteOps {
  @inlinable
  static func scalarAt<C: RandomAccessCollection>(_ bytes: C, _ i: Int, _ n: Int) -> (UInt32, Int)
  where C.Element == UInt8, C.Index == Int {
    let b0 = bytes[i]
    if b0 < 0x80 { return (UInt32(b0), 1) }
    if b0 & 0xE0 == 0xC0, i + 1 < n {
      return ((UInt32(b0 & 0x1F) << 6) | UInt32(bytes[i + 1] & 0x3F), 2)
    }
    if b0 & 0xF0 == 0xE0, i + 2 < n {
      return ((UInt32(b0 & 0x0F) << 12) | (UInt32(bytes[i + 1] & 0x3F) << 6) | UInt32(bytes[i + 2] & 0x3F), 3)
    }
    if b0 & 0xF8 == 0xF0, i + 3 < n {
      return (
        (UInt32(b0 & 0x07) << 18) | (UInt32(bytes[i + 1] & 0x3F) << 12)
          | (UInt32(bytes[i + 2] & 0x3F) << 6) | UInt32(bytes[i + 3] & 0x3F), 4
      )
    }
    return (0xFFFD, 1)
  }

  @inlinable
  public static func whitespaceWidth<C: RandomAccessCollection>(_ bytes: C, _ i: Int, _ n: Int) -> Int?
  where C.Element == UInt8, C.Index == Int {
    let byte = bytes[i]
    if byte < 0x80 {
      return byte == 0x20 || (byte >= 0x09 && byte <= 0x0D) ? 1 : nil
    }
    let (value, width) = scalarAt(bytes, i, n)
    return UnicodeSets.isJsWhitespace(value) ? width : nil
  }

  /// JS trim bounds over bytes[start..<end].
  public static func trimRange<C: RandomAccessCollection>(_ bytes: C, _ start: Int, _ end: Int) -> (Int, Int)
  where C.Element == UInt8, C.Index == Int {
    var s = start
    while s < end {
      guard let width = whitespaceWidth(bytes, s, end) else { break }
      s += width
    }
    var e = end
    while e > s {
      var scalarStart = e - 1
      while scalarStart > s, bytes[scalarStart] & 0xC0 == 0x80 { scalarStart -= 1 }
      guard let width = whitespaceWidth(bytes, scalarStart, end), scalarStart + width == e else { break }
      e = scalarStart
    }
    return (s, e)
  }

  /// The document finisher: collapse \n{3,} → \n\n, JS-trim, optional
  /// trailing \n — streamed from `source` into `out` (reused buffer).
  public static func finishDocument(_ source: [UInt8], into out: inout [UInt8], trailingNewline: Bool) {
    out.removeAll(keepingCapacity: true)
    out.reserveCapacity(source.count + 1)
    var run = 0
    for byte in source {
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
    let (start, end) = trimRange(out, 0, out.count)
    if end < out.count { out.removeLast(out.count - end) }
    if start > 0 { out.removeSubrange(0..<start) }
    if trailingNewline { out.append(0x0A) }
  }
}

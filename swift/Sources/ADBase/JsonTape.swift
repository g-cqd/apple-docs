// Tape JSON for the content hot path (RFC 0004 D-0004-6's registered
// precondition). One pass over the input produces a flat array of packed
// records; strings stay as SPANS into the input (escape-free) or into a
// per-parse scratch (decoded once at parse). No per-node heap objects, no
// Dictionary hashing — object lookup is a linear UTF-8 compare over the
// node's keys (DocC objects carry ~3-10).
//
// Semantics guards (parity with JSON.parse via the eager parser):
//   - duplicate keys / oversize spans / invalid UTF-8 → the eager
//     JsonValue parser runs instead and its tree is converted onto the
//     tape — renderers stay tape-only;
//   - the safeJson entry mirrors src/content/safe-json.js: parse error or
//     container depth > 64 → nil;
//   - the input buffer must outlive the tape (exports parse and render
//     within one FFI call; convertFile keeps its read buffer alive).
//
// Storage is `let` (built by the TapeBuilder struct, then frozen): class
// `var` ivars would pay swift_beginAccess exclusivity checks on every
// byte of the build loops and every cursor read — measured as the top
// profile entry before this shape.
//
// Record encoding (UInt64):
//   bits 60..63  kind (Kind raw)
//   bits 56..59  flags (string: 1 = span lives in scratch; bool: 1 = true)
//   strings/numbers: bits 0..29 offset (≤ 1 GiB), bits 30..53 length (≤ 16 MiB)
//   containers:      bits 0..29 end tape index,   bits 30..53 child count
//   boxed numbers (adopted trees only): payload in the FOLLOWING word.

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// @unchecked Sendable: a tape is IMMUTABLE after `parse` returns (all
/// storage is `let`); batch exports read one tape from many threads.
public final class JsonTape: @unchecked Sendable {
  public enum Kind: UInt8 {
    case null = 0
    case bool = 1
    case number = 2
    case numberBoxed = 3
    case string = 4
    case array = 5
    case object = 6
  }

  enum BuildError: Error {
    case syntax
    case depthExceeded
    case needsEager // dup keys / span limits / invalid UTF-8
  }

  @usableFromInline let tape: [UInt64]
  @usableFromInline let input: UnsafeRawBufferPointer
  @usableFromInline let scratch: [UInt8]

  static let maxSpanOffset = (1 << 30) - 1
  static let maxSpanLength = (1 << 24) - 1

  init(input: UnsafeRawBufferPointer, tape: [UInt64], scratch: [UInt8]) {
    self.input = input
    self.tape = tape
    self.scratch = scratch
  }

  // MARK: - Entries

  /// Plain JSON.parse equivalent over `bytes` (which must stay alive for
  /// the tape's lifetime). Throws on syntax errors like JSON.parse.
  public static func parse(_ bytes: UnsafeRawBufferPointer, maxContainerDepth: Int = 512) throws -> JsonTape {
    var builder = TapeBuilder(input: bytes, maxDepth: maxContainerDepth)
    do {
      try builder.build()
      return JsonTape(input: bytes, tape: builder.tape, scratch: builder.scratch)
    } catch BuildError.needsEager {
      // Correctness fallback: eager parse (dup-key semantics, UTF-8
      // repair via String(decoding:)), then adopt the tree.
      let value = try Json.parse(Array(bytes.bindMemory(to: UInt8.self)), maxContainerDepth: maxContainerDepth)
      var adopter = TapeAdopter()
      adopter.append(value)
      return JsonTape(input: bytes, tape: adopter.tape, scratch: adopter.scratch)
    } catch BuildError.depthExceeded {
      throw JsonError.depthExceeded
    } catch {
      throw JsonError.syntax("tape parse failed")
    }
  }

  /// src/content/safe-json.js semantics: parse error → nil, container
  /// depth > 64 → nil.
  public static func safeJson(_ bytes: UnsafeRawBufferPointer) -> JsonTape? {
    try? parse(bytes, maxContainerDepth: 64)
  }

  // MARK: - Cursor API (index-based; no per-node objects)

  @inlinable public var root: Int { 0 }

  @inlinable public func kind(_ index: Int) -> Kind {
    Kind(rawValue: UInt8((tape[index] >> 60) & 0xF))!
  }

  @inlinable func flags(_ index: Int) -> UInt8 {
    UInt8((tape[index] >> 56) & 0xF)
  }

  @inlinable func spanOffset(_ index: Int) -> Int {
    Int(tape[index] & 0x3FFF_FFFF)
  }

  @inlinable func spanLength(_ index: Int) -> Int {
    Int((tape[index] >> 30) & 0xFF_FFFF)
  }

  @inlinable public func childCount(_ index: Int) -> Int {
    Int((tape[index] >> 30) & 0xFF_FFFF)
  }

  @inlinable public func endIndex(_ index: Int) -> Int {
    Int(tape[index] & 0x3FFF_FFFF)
  }

  /// The tape index immediately after this node's subtree.
  @inlinable public func skip(_ index: Int) -> Int {
    switch kind(index) {
    case .array, .object: return endIndex(index)
    case .numberBoxed: return index + 2
    default: return index + 1
    }
  }

  @inlinable public func isNull(_ index: Int) -> Bool { kind(index) == .null }

  /// JS truthiness for the node.
  public func isTruthy(_ index: Int) -> Bool {
    switch kind(index) {
    case .null: return false
    case .bool: return flags(index) != 0
    case .number, .numberBoxed:
      let value = numberValue(index)
      return value != 0 && !value.isNaN
    case .string: return spanLength(index) != 0
    case .array, .object: return true
    }
  }

  /// UTF-8 span of a string node (input or scratch).
  @inlinable public func withStringBytes<R>(_ index: Int, _ body: (UnsafeRawBufferPointer) -> R) -> R {
    let offset = spanOffset(index)
    let length = spanLength(index)
    if flags(index) & 1 != 0 {
      return scratch.withUnsafeBytes { buffer in
        body(UnsafeRawBufferPointer(rebasing: buffer[offset..<offset + length]))
      }
    }
    return body(UnsafeRawBufferPointer(rebasing: input[offset..<offset + length]))
  }

  public func string(_ index: Int) -> String {
    withStringBytes(index) { bytes in
      String(unsafeUninitializedCapacity: bytes.count) { out in
        if bytes.count > 0 {
          out.baseAddress!.update(from: bytes.bindMemory(to: UInt8.self).baseAddress!, count: bytes.count)
        }
        return bytes.count
      }
    }
  }

  /// Byte-compare a string node against an ASCII literal.
  @inlinable public func stringEquals(_ index: Int, _ literal: StaticString) -> Bool {
    guard kind(index) == .string, spanLength(index) == literal.utf8CodeUnitCount else { return false }
    return withStringBytes(index) { bytes in
      memcmp(bytes.baseAddress, literal.utf8Start, literal.utf8CodeUnitCount) == 0
    }
  }

  public func numberValue(_ index: Int) -> Double {
    if kind(index) == .numberBoxed {
      return Double(bitPattern: tape[index + 1])
    }
    // Lexeme → Double (locale-independent Swift parser, same as eager).
    let text = string(index)
    return Double(text) ?? 0
  }

  /// ECMAScript ToString of the node (template/coercion semantics — the
  /// tape twin of JsonValue.jsStringCoercion).
  public func jsStringCoercion(_ index: Int) -> String {
    switch kind(index) {
    case .null: return "null"
    case .bool: return flags(index) != 0 ? "true" : "false"
    case .number, .numberBoxed: return Json.ecmaNumberToString(numberValue(index))
    case .string: return string(index)
    case .object: return "[object Object]"
    case .array:
      var parts: [String] = []
      var child = index + 1
      let end = endIndex(index)
      while child < end {
        parts.append(isNull(child) ? "" : jsStringCoercion(child))
        child = skip(child)
      }
      return parts.joined(separator: ",")
    }
  }

  /// First child value for `key` (objects have no duplicate keys on the
  /// fast path — duplicates re-route through the eager parser at build).
  public func member(_ index: Int, _ key: StaticString) -> Int? {
    guard kind(index) == .object else { return nil }
    var child = index + 1
    let end = endIndex(index)
    while child < end {
      let valueIndex = child + 1
      if stringEquals(child, key) { return valueIndex }
      child = skip(valueIndex)
    }
    return nil
  }

  /// Iterate (keyIndex, valueIndex) pairs in insertion order.
  public func forEachMember(_ index: Int, _ body: (Int, Int) -> Void) {
    guard kind(index) == .object else { return }
    var child = index + 1
    let end = endIndex(index)
    while child < end {
      let valueIndex = child + 1
      body(child, valueIndex)
      child = skip(valueIndex)
    }
  }

  /// Iterate element indices of an array.
  public func forEachElement(_ index: Int, _ body: (Int) -> Void) {
    guard kind(index) == .array else { return }
    var child = index + 1
    let end = endIndex(index)
    while child < end {
      body(child)
      child = skip(child)
    }
  }

  /// First element of an array, if any.
  public func firstElement(_ index: Int) -> Int? {
    guard kind(index) == .array, childCount(index) > 0 else { return nil }
    return index + 1
  }
}

// MARK: - Builder (struct locals — no exclusivity checks in the loops)

private func tapeRecord(kind: JsonTape.Kind, flags: UInt8 = 0, a: Int = 0, b: Int = 0) -> UInt64 {
  (UInt64(kind.rawValue) << 60) | (UInt64(flags) << 56) | (UInt64(b) << 30) | UInt64(a)
}

struct TapeBuilder {
  let input: UnsafeRawBufferPointer
  let maxDepth: Int
  var tape: [UInt64] = []
  var scratch: [UInt8] = []
  var pos = 0

  init(input: UnsafeRawBufferPointer, maxDepth: Int) {
    self.input = input
    self.maxDepth = maxDepth
  }

  @inline(__always)
  func byte(_ at: Int) -> UInt8 {
    input.load(fromByteOffset: at, as: UInt8.self)
  }

  mutating func build() throws {
    guard validateUtf8() else { throw JsonTape.BuildError.needsEager }
    tape.reserveCapacity(min(input.count / 4 + 8, 1 << 22))
    try buildValue(depth: 0)
    skipWs()
    guard pos == input.count else { throw JsonTape.BuildError.syntax }
  }

  mutating func skipWs() {
    while pos < input.count {
      switch byte(pos) {
      case 0x20, 0x09, 0x0A, 0x0D: pos += 1
      default: return
      }
    }
  }

  mutating func buildValue(depth: Int) throws {
    skipWs()
    guard pos < input.count else { throw JsonTape.BuildError.syntax }
    switch byte(pos) {
    case UInt8(ascii: "{"):
      guard depth <= maxDepth else { throw JsonTape.BuildError.depthExceeded }
      try buildObject(depth: depth)
    case UInt8(ascii: "["):
      guard depth <= maxDepth else { throw JsonTape.BuildError.depthExceeded }
      try buildArray(depth: depth)
    case UInt8(ascii: "\""):
      try buildString()
    case UInt8(ascii: "t"):
      try expect("true")
      tape.append(tapeRecord(kind: .bool, flags: 1))
    case UInt8(ascii: "f"):
      try expect("false")
      tape.append(tapeRecord(kind: .bool, flags: 0))
    case UInt8(ascii: "n"):
      try expect("null")
      tape.append(tapeRecord(kind: .null))
    default:
      try buildNumber()
    }
  }

  mutating func expect(_ literal: StaticString) throws {
    guard pos + literal.utf8CodeUnitCount <= input.count else { throw JsonTape.BuildError.syntax }
    for i in 0..<literal.utf8CodeUnitCount {
      guard byte(pos + i) == literal.utf8Start[i] else { throw JsonTape.BuildError.syntax }
    }
    pos += literal.utf8CodeUnitCount
  }

  // Span readers over the PARTIAL tape (dup-key detection).
  func spanBytesEqual(_ a: Int, _ b: Int) -> Bool {
    let lenA = Int((tape[a] >> 30) & 0xFF_FFFF)
    let lenB = Int((tape[b] >> 30) & 0xFF_FFFF)
    guard lenA == lenB else { return false }
    let offA = Int(tape[a] & 0x3FFF_FFFF)
    let offB = Int(tape[b] & 0x3FFF_FFFF)
    let inScratchA = (tape[a] >> 56) & 1 != 0
    let inScratchB = (tape[b] >> 56) & 1 != 0
    return scratch.withUnsafeBytes { scratchBytes -> Bool in
      let baseA = inScratchA ? scratchBytes.baseAddress! + offA : input.baseAddress! + offA
      let baseB = inScratchB ? scratchBytes.baseAddress! + offB : input.baseAddress! + offB
      return memcmp(baseA, baseB, lenA) == 0
    }
  }

  func skipIndex(_ index: Int) -> Int {
    let kind = JsonTape.Kind(rawValue: UInt8((tape[index] >> 60) & 0xF))!
    switch kind {
    case .array, .object: return Int(tape[index] & 0x3FFF_FFFF)
    case .numberBoxed: return index + 2
    default: return index + 1
    }
  }

  mutating func buildObject(depth: Int) throws {
    let recordIndex = tape.count
    tape.append(0) // patched below
    pos += 1
    var count = 0
    skipWs()
    if pos < input.count, byte(pos) == UInt8(ascii: "}") {
      pos += 1
      tape[recordIndex] = tapeRecord(kind: .object, a: tape.count, b: 0)
      return
    }
    let firstKeyTapeIndex = tape.count
    while true {
      skipWs()
      guard pos < input.count, byte(pos) == UInt8(ascii: "\"") else { throw JsonTape.BuildError.syntax }
      let keyTapeIndex = tape.count
      try buildString()
      // Duplicate-key detection (ECMA last-wins-first-position needs the
      // eager tree): linear compare against prior keys of THIS object.
      var prior = firstKeyTapeIndex
      while prior < keyTapeIndex {
        if spanBytesEqual(prior, keyTapeIndex) { throw JsonTape.BuildError.needsEager }
        prior = skipIndex(prior + 1) // skip prior key's value subtree
      }
      skipWs()
      guard pos < input.count, byte(pos) == UInt8(ascii: ":") else { throw JsonTape.BuildError.syntax }
      pos += 1
      try buildValue(depth: depth + 1)
      count += 1
      skipWs()
      guard pos < input.count else { throw JsonTape.BuildError.syntax }
      if byte(pos) == UInt8(ascii: ",") {
        pos += 1
        continue
      }
      if byte(pos) == UInt8(ascii: "}") {
        pos += 1
        guard count <= JsonTape.maxSpanLength, tape.count <= JsonTape.maxSpanOffset else {
          throw JsonTape.BuildError.needsEager
        }
        tape[recordIndex] = tapeRecord(kind: .object, a: tape.count, b: count)
        return
      }
      throw JsonTape.BuildError.syntax
    }
  }

  mutating func buildArray(depth: Int) throws {
    let recordIndex = tape.count
    tape.append(0)
    pos += 1
    var count = 0
    skipWs()
    if pos < input.count, byte(pos) == UInt8(ascii: "]") {
      pos += 1
      tape[recordIndex] = tapeRecord(kind: .array, a: tape.count, b: 0)
      return
    }
    while true {
      try buildValue(depth: depth + 1)
      count += 1
      skipWs()
      guard pos < input.count else { throw JsonTape.BuildError.syntax }
      if byte(pos) == UInt8(ascii: ",") {
        pos += 1
        continue
      }
      if byte(pos) == UInt8(ascii: "]") {
        pos += 1
        guard count <= JsonTape.maxSpanLength, tape.count <= JsonTape.maxSpanOffset else {
          throw JsonTape.BuildError.needsEager
        }
        tape[recordIndex] = tapeRecord(kind: .array, a: tape.count, b: count)
        return
      }
      throw JsonTape.BuildError.syntax
    }
  }

  mutating func buildString() throws {
    pos += 1 // opening quote
    let start = pos
    // Fast path: no escapes → zero-copy span into the input.
    while pos < input.count {
      let b = byte(pos)
      if b == UInt8(ascii: "\"") {
        let length = pos - start
        guard start <= JsonTape.maxSpanOffset, length <= JsonTape.maxSpanLength else {
          throw JsonTape.BuildError.needsEager
        }
        tape.append(tapeRecord(kind: .string, flags: 0, a: start, b: length))
        pos += 1
        return
      }
      if b == UInt8(ascii: "\\") { break }
      if b < 0x20 { throw JsonTape.BuildError.syntax }
      pos += 1
    }
    guard pos < input.count else { throw JsonTape.BuildError.syntax }

    // Escaped: decode into scratch (same escape semantics as the eager
    // parser, incl. lone-surrogate → U+FFFD).
    let scratchStart = scratch.count
    scratch.append(contentsOf: input[start..<pos].bindMemory(to: UInt8.self))
    while true {
      guard pos < input.count else { throw JsonTape.BuildError.syntax }
      let b = byte(pos)
      if b == UInt8(ascii: "\"") {
        pos += 1
        let length = scratch.count - scratchStart
        guard scratchStart <= JsonTape.maxSpanOffset, length <= JsonTape.maxSpanLength else {
          throw JsonTape.BuildError.needsEager
        }
        tape.append(tapeRecord(kind: .string, flags: 1, a: scratchStart, b: length))
        return
      }
      if b == UInt8(ascii: "\\") {
        pos += 1
        guard pos < input.count else { throw JsonTape.BuildError.syntax }
        switch byte(pos) {
        case UInt8(ascii: "\""): scratch.append(UInt8(ascii: "\"")); pos += 1
        case UInt8(ascii: "\\"): scratch.append(UInt8(ascii: "\\")); pos += 1
        case UInt8(ascii: "/"): scratch.append(UInt8(ascii: "/")); pos += 1
        case UInt8(ascii: "b"): scratch.append(0x08); pos += 1
        case UInt8(ascii: "f"): scratch.append(0x0C); pos += 1
        case UInt8(ascii: "n"): scratch.append(UInt8(ascii: "\n")); pos += 1
        case UInt8(ascii: "r"): scratch.append(UInt8(ascii: "\r")); pos += 1
        case UInt8(ascii: "t"): scratch.append(UInt8(ascii: "\t")); pos += 1
        case UInt8(ascii: "u"):
          pos += 1
          let unit = try hex4()
          if unit >= 0xD800, unit <= 0xDBFF {
            if pos + 1 < input.count, byte(pos) == UInt8(ascii: "\\"), byte(pos + 1) == UInt8(ascii: "u") {
              let saved = pos
              pos += 2
              let low = try hex4()
              if low >= 0xDC00, low <= 0xDFFF {
                appendScalarUtf8(UInt32(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)))
              } else {
                appendScalarUtf8(0xFFFD)
                pos = saved
              }
            } else {
              appendScalarUtf8(0xFFFD)
            }
          } else if unit >= 0xDC00, unit <= 0xDFFF {
            appendScalarUtf8(0xFFFD)
          } else {
            appendScalarUtf8(UInt32(unit))
          }
        default:
          throw JsonTape.BuildError.syntax
        }
        continue
      }
      if b < 0x20 { throw JsonTape.BuildError.syntax }
      scratch.append(b)
      pos += 1
    }
  }

  mutating func appendScalarUtf8(_ value: UInt32) {
    if value < 0x80 {
      scratch.append(UInt8(value))
    } else if value < 0x800 {
      scratch.append(UInt8(0xC0 | (value >> 6)))
      scratch.append(UInt8(0x80 | (value & 0x3F)))
    } else if value < 0x10000 {
      scratch.append(UInt8(0xE0 | (value >> 12)))
      scratch.append(UInt8(0x80 | ((value >> 6) & 0x3F)))
      scratch.append(UInt8(0x80 | (value & 0x3F)))
    } else {
      scratch.append(UInt8(0xF0 | (value >> 18)))
      scratch.append(UInt8(0x80 | ((value >> 12) & 0x3F)))
      scratch.append(UInt8(0x80 | ((value >> 6) & 0x3F)))
      scratch.append(UInt8(0x80 | (value & 0x3F)))
    }
  }

  mutating func hex4() throws -> Int {
    guard pos + 4 <= input.count else { throw JsonTape.BuildError.syntax }
    var value = 0
    for i in 0..<4 {
      let b = byte(pos + i)
      let digit: Int
      switch b {
      case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = Int(b - UInt8(ascii: "0"))
      case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = Int(b - UInt8(ascii: "a")) + 10
      case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = Int(b - UInt8(ascii: "A")) + 10
      default: throw JsonTape.BuildError.syntax
      }
      value = value * 16 + digit
    }
    pos += 4
    return value
  }

  mutating func buildNumber() throws {
    let start = pos
    if pos < input.count, byte(pos) == UInt8(ascii: "-") { pos += 1 }
    guard pos < input.count else { throw JsonTape.BuildError.syntax }
    if byte(pos) == UInt8(ascii: "0") {
      pos += 1
    } else if byte(pos) >= UInt8(ascii: "1"), byte(pos) <= UInt8(ascii: "9") {
      while pos < input.count, byte(pos) >= UInt8(ascii: "0"), byte(pos) <= UInt8(ascii: "9") { pos += 1 }
    } else {
      throw JsonTape.BuildError.syntax
    }
    if pos < input.count, byte(pos) == UInt8(ascii: ".") {
      pos += 1
      let fracStart = pos
      while pos < input.count, byte(pos) >= UInt8(ascii: "0"), byte(pos) <= UInt8(ascii: "9") { pos += 1 }
      guard pos > fracStart else { throw JsonTape.BuildError.syntax }
    }
    if pos < input.count, byte(pos) == UInt8(ascii: "e") || byte(pos) == UInt8(ascii: "E") {
      pos += 1
      if pos < input.count, byte(pos) == UInt8(ascii: "+") || byte(pos) == UInt8(ascii: "-") { pos += 1 }
      let expStart = pos
      while pos < input.count, byte(pos) >= UInt8(ascii: "0"), byte(pos) <= UInt8(ascii: "9") { pos += 1 }
      guard pos > expStart else { throw JsonTape.BuildError.syntax }
    }
    let length = pos - start
    guard start <= JsonTape.maxSpanOffset, length <= JsonTape.maxSpanLength else {
      throw JsonTape.BuildError.needsEager
    }
    tape.append(tapeRecord(kind: .number, a: start, b: length))
  }

  /// Whole-buffer UTF-8 validation (ASCII fast path) — invalid input
  /// re-routes through the eager parser so String(decoding:) repair
  /// semantics stay byte-faithful.
  func validateUtf8() -> Bool {
    var i = 0
    let n = input.count
    while i < n {
      let b0 = byte(i)
      if b0 < 0x80 {
        i += 1
        continue
      }
      if b0 & 0xE0 == 0xC0 {
        guard b0 >= 0xC2, i + 1 < n, byte(i + 1) & 0xC0 == 0x80 else { return false }
        i += 2
      } else if b0 & 0xF0 == 0xE0 {
        guard i + 2 < n, byte(i + 1) & 0xC0 == 0x80, byte(i + 2) & 0xC0 == 0x80 else { return false }
        let scalar = (UInt32(b0 & 0x0F) << 12) | (UInt32(byte(i + 1) & 0x3F) << 6) | UInt32(byte(i + 2) & 0x3F)
        guard scalar >= 0x800, scalar < 0xD800 || scalar > 0xDFFF else { return false }
        i += 3
      } else if b0 & 0xF8 == 0xF0 {
        guard i + 3 < n, byte(i + 1) & 0xC0 == 0x80, byte(i + 2) & 0xC0 == 0x80, byte(i + 3) & 0xC0 == 0x80
        else { return false }
        let scalar =
          (UInt32(b0 & 0x07) << 18) | (UInt32(byte(i + 1) & 0x3F) << 12)
          | (UInt32(byte(i + 2) & 0x3F) << 6) | UInt32(byte(i + 3) & 0x3F)
        guard scalar >= 0x10000, scalar <= 0x10FFFF else { return false }
        i += 4
      } else {
        return false
      }
    }
    return true
  }
}

/// Serializes an eager JsonValue tree into tape arrays (strings move into
/// scratch; numbers are boxed) — the correctness fallback.
struct TapeAdopter {
  var tape: [UInt64] = []
  var scratch: [UInt8] = []

  mutating func append(_ value: JsonValue) {
    switch value {
    case .null:
      tape.append(tapeRecord(kind: .null))
    case .bool(let b):
      tape.append(tapeRecord(kind: .bool, flags: b ? 1 : 0))
    case .number(let n):
      tape.append(tapeRecord(kind: .numberBoxed))
      tape.append(n.bitPattern)
    case .string(let s):
      appendString(s)
    case .array(let items):
      let recordIndex = tape.count
      tape.append(0)
      for item in items { append(item) }
      tape[recordIndex] = tapeRecord(
        kind: .array, a: tape.count, b: min(items.count, JsonTape.maxSpanLength))
    case .object(let object):
      let recordIndex = tape.count
      tape.append(0)
      let entries = object.entries
      for (key, item) in entries {
        appendString(key)
        append(item)
      }
      tape[recordIndex] = tapeRecord(
        kind: .object, a: tape.count, b: min(entries.count, JsonTape.maxSpanLength))
    }
  }

  private mutating func appendString(_ s: String) {
    var s = s
    let offset = scratch.count
    s.withUTF8 { scratch.append(contentsOf: $0) }
    tape.append(
      tapeRecord(
        kind: .string, flags: 1, a: offset,
        b: min(scratch.count - offset, JsonTape.maxSpanLength)))
  }
}

/// Bounds-checked little-endian reader over a request buffer. Every read
/// returns nil past the end instead of trapping — the no-trap rule applies
/// to request decoding above all (a malformed buffer must surface as
/// `.invalidInput`, never abort the host process).
public struct RequestReader {
  private let buf: UnsafeRawBufferPointer
  public private(set) var offset: Int

  public init(_ buf: UnsafeRawBufferPointer) {
    self.buf = buf
    self.offset = 0
  }

  public var remaining: Int { buf.count - offset }

  public mutating func u32() -> UInt32? {
    guard remaining >= 4, let base = buf.baseAddress else { return nil }
    let value = base.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
    offset += 4
    return UInt32(littleEndian: value)
  }

  public mutating func u64() -> UInt64? {
    guard remaining >= 8, let base = buf.baseAddress else { return nil }
    let value = base.loadUnaligned(fromByteOffset: offset, as: UInt64.self)
    offset += 8
    return UInt64(littleEndian: value)
  }

  public mutating func f64() -> Double? {
    guard remaining >= 8, let base = buf.baseAddress else { return nil }
    let bits = base.loadUnaligned(fromByteOffset: offset, as: UInt64.self)
    offset += 8
    return Double(bitPattern: UInt64(littleEndian: bits))
  }

  /// A view over the next `count` bytes (no copy); nil if out of bounds.
  public mutating func bytes(_ count: Int) -> UnsafeRawBufferPointer? {
    guard count >= 0, remaining >= count, let base = buf.baseAddress else { return nil }
    let view = UnsafeRawBufferPointer(start: base + offset, count: count)
    offset += count
    return view
  }

  /// Advances to the next 8-byte boundary (relative to buffer start).
  public mutating func align8() -> Bool {
    let pad = (8 - (offset % 8)) % 8
    guard remaining >= pad else { return false }
    offset += pad
    return true
  }
}

// Length-prefixed field readers shared by every `@_cdecl` export. The wire is
// `[u32 len][bytes]`; for the nullable forms `len == nullSentinel` means null
// (distinct from a zero-length value). The double Optional encodes "malformed
// /truncated" (outer nil) vs "explicit null" (`.some(nil)`).
extension RequestReader {
  /// `[u32 len][bytes]`: a zero-copy view, `.some(nil)` for the null sentinel,
  /// outer nil when truncated or `len > max`.
  public mutating func nullableSpan(max: Int) -> UnsafeRawBufferPointer?? {
    guard let length = u32() else { return nil }
    if length == nullSentinel { return .some(nil) }
    guard Int(length) <= max, let view = bytes(Int(length)) else { return nil }
    return .some(view)
  }

  /// `[u32 len][utf8]`: the decoded string, `.some(nil)` for the null sentinel,
  /// outer nil when truncated or `len > max`.
  public mutating func nullableString(max: Int) -> String?? {
    guard let length = u32() else { return nil }
    if length == nullSentinel { return .some(nil) }
    guard Int(length) <= max, let view = bytes(Int(length)) else { return nil }
    return .some(String(decoding: view, as: UTF8.self))
  }

  /// `[u32 len][utf8]` with no null sentinel: the decoded string, or nil when
  /// truncated or `len > max`.
  public mutating func lengthString(max: Int) -> String? {
    guard let length = u32(), Int(length) <= max, let view = bytes(Int(length)) else { return nil }
    return String(decoding: view, as: UTF8.self)
  }
}

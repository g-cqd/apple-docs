import ADFCore

/// Length-prefixed request decoding for the `@_cdecl` FFI boundary. The bounds-checked, no-trap
/// little-endian core is ``ADFCore/ByteReader``; this wraps it and adds the wire framing
/// (`[u32 len][bytes]`, with `len == nullSentinel` meaning an explicit null).
public struct RequestReader {
    private var inner: ByteReader
    public init(_ buf: UnsafeRawBufferPointer) { inner = ByteReader(buf) }

    public var offset: Int { inner.offset }
    public var remaining: Int { inner.remaining }

    public mutating func u32() -> UInt32? { inner.u32() }
    public mutating func u64() -> UInt64? { inner.u64() }
    public mutating func f64() -> Double? { inner.f64() }
    public mutating func bytes(_ count: Int) -> UnsafeRawBufferPointer? { inner.bytes(count) }
    public mutating func align8() -> Bool { inner.align8() }
}

// Length-prefixed field readers shared by every `@_cdecl` export. The wire is `[u32 len][bytes]`;
// for the nullable forms `len == nullSentinel` means null (distinct from a zero-length value). The
// double Optional encodes "malformed / truncated" (outer nil) vs "explicit null" (`.some(nil)`).
extension RequestReader {
    /// `[u32 len][bytes]`: a zero-copy view, `.some(nil)` for the null sentinel, outer nil when
    /// truncated or `len > max`.
    public mutating func nullableSpan(max: Int) -> UnsafeRawBufferPointer?? {
        guard let length = u32() else { return nil }
        if length == nullSentinel { return .some(nil) }
        guard Int(length) <= max, let view = bytes(Int(length)) else { return nil }
        return .some(view)
    }

    /// `[u32 len][utf8]`: the decoded string, `.some(nil)` for the null sentinel, outer nil when
    /// truncated or `len > max`.
    public mutating func nullableString(max: Int) -> String?? {
        guard let length = u32() else { return nil }
        if length == nullSentinel { return .some(nil) }
        guard Int(length) <= max, let view = bytes(Int(length)) else { return nil }
        return .some(String(decoding: view, as: UTF8.self))
    }

    /// `[u32 len][utf8]` with no null sentinel: the decoded string, or nil when truncated or `len > max`.
    public mutating func lengthString(max: Int) -> String? {
        guard let length = u32(), Int(length) <= max, let view = bytes(Int(length)) else { return nil }
        return String(decoding: view, as: UTF8.self)
    }
}

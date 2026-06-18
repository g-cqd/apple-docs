// Result allocation: one malloc'ed block per result,
// [u64 payloadLen LE][u32 status LE][u8 formatId][3 reserved] + payload at 16.
// malloc/free symmetry is normative: callers must call ad_free exactly once.

import ADFCore

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

public enum ResultBuffer {
    public static let headerSize = 16

    /// Allocates a result block and returns (base, payload) so callers can
    /// write the payload in place. nil only on allocation failure.
    public static func allocate(
        status: ADStatus, format: ADFormat, payloadCount: Int
    ) -> (base: UnsafeMutableRawPointer, payload: UnsafeMutableRawBufferPointer)? {
        guard payloadCount >= 0,
            let total = headerSize.checkedAdding(payloadCount),
            let base = malloc(total)
        else { return nil }
        memset(base, 0, headerSize)
        base.storeBytes(of: UInt64(payloadCount).littleEndian, toByteOffset: 0, as: UInt64.self)
        base.storeBytes(of: status.rawValue.littleEndian, toByteOffset: 8, as: UInt32.self)
        base.storeBytes(of: format.rawValue, toByteOffset: 12, as: UInt8.self)
        let payload = UnsafeMutableRawBufferPointer(start: base + headerSize, count: payloadCount)
        return (base, payload)
    }

    public static func make(
        status: ADStatus, format: ADFormat, payload: UnsafeRawBufferPointer?
    ) -> UnsafeMutableRawPointer? {
        let count = payload?.count ?? 0
        guard let (base, _) = allocate(status: status, format: format, payloadCount: count) else { return nil }
        if let src = payload?.baseAddress, count > 0 {
            // Non-optional pointer arithmetic: Glibc imports memcpy's dst as
            // non-nullable (Darwin doesn't), so `dest.baseAddress` won't compile
            // on Linux.
            memcpy(base + headerSize, src, count)
        }
        return base
    }

    public static func text(
        status: ADStatus, format: ADFormat, _ text: String
    ) -> UnsafeMutableRawPointer? {
        var text = text
        return text.withUTF8 { make(status: status, format: format, payload: UnsafeRawBufferPointer($0)) }
    }

    public static func error(_ status: ADStatus, _ message: String) -> UnsafeMutableRawPointer? {
        text(status: status, format: .utf8, message)
    }

    public static func free(_ ptr: UnsafeMutableRawPointer?) {
        #if canImport(Darwin)
            Darwin.free(ptr)
        #else
            Glibc.free(ptr)
        #endif
    }
}

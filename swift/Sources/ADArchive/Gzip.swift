// Runtime dlopen/dlsym binding to the system zlib — the S4 gzip seam
// (sitemaps) and the shared inflate the S10 native unzip builds on.
//
// Same shape as Zstd.swift: dlopen keeps `swift build` zero-dep; a missing
// libz degrades to nil and callers surface the miss. libz ships with macOS
// (/usr/lib/libz.1.dylib) and every mainstream Linux (libz.so.1), so the nil
// path is effectively unreachable in practice.
//
// BYTE-PARITY NOTE (recorded per the S4 gate instructions): `Bun.gzipSync`
// does NOT emit byte-identical streams to classic zlib at any compression
// level — bun vendors a zlib-ng-lineage deflate whose bitstream differs
// mid-stream (verified empirically: identical header + identical LENGTH at
// level 6, different Huffman-coded bytes; levels 1-9 all differ). Both are
// valid, equivalent gzip members. The web-parity gate therefore compares
// GUNZIPPED content for *.gz artifacts instead of raw bytes.

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

/// zlib's `z_stream` (LP64 layout — pointer/uLong fields are 8 bytes, the two
/// uInt fields 4 with natural padding; 112 bytes total, which `stream_size`
/// asserts against zlib's own sizeof at init).
struct ZlibStream {
    var nextIn: UnsafeMutablePointer<UInt8>? = nil
    var availIn: UInt32 = 0
    var totalIn: UInt = 0
    var nextOut: UnsafeMutablePointer<UInt8>? = nil
    var availOut: UInt32 = 0
    var totalOut: UInt = 0
    var msg: UnsafeMutablePointer<CChar>? = nil
    var state: OpaquePointer? = nil
    var zalloc: UnsafeMutableRawPointer? = nil
    var zfree: UnsafeMutableRawPointer? = nil
    var opaque: UnsafeMutableRawPointer? = nil
    var dataType: Int32 = 0
    var adler: UInt = 0
    var reserved: UInt = 0
}

/// The bound zlib entry points (versioned `*Init2_` forms — the public macros
/// pass ZLIB_VERSION + sizeof(z_stream) for ABI checking).
struct ZlibLib {
    let version: @convention(c) () -> UnsafePointer<CChar>?
    let deflateInit2: @convention(c) (
        UnsafeMutableRawPointer?, Int32, Int32, Int32, Int32, Int32, UnsafePointer<CChar>?, Int32
    ) -> Int32
    let deflate: @convention(c) (UnsafeMutableRawPointer?, Int32) -> Int32
    let deflateEnd: @convention(c) (UnsafeMutableRawPointer?) -> Int32
    let deflateBound: @convention(c) (UnsafeMutableRawPointer?, UInt) -> UInt
    let inflateInit2: @convention(c) (UnsafeMutableRawPointer?, Int32, UnsafePointer<CChar>?, Int32) -> Int32
    let inflate: @convention(c) (UnsafeMutableRawPointer?, Int32) -> Int32
    let inflateEnd: @convention(c) (UnsafeMutableRawPointer?) -> Int32
}

public enum Gzip {
    /// zlib return codes / flush modes we use.
    private static let zOK: Int32 = 0
    private static let zStreamEnd: Int32 = 1
    private static let zFinish: Int32 = 4
    private static let zNoFlush: Int32 = 0
    /// windowBits 15 + 16 selects the gzip wrapper (deflate); on inflate,
    /// 15 + 32 auto-detects gzip vs zlib framing.
    private static let gzipEncodeWindowBits: Int32 = 15 + 16
    private static let gzipDecodeWindowBits: Int32 = 15 + 32

    private static let candidates: [String] = {
        #if canImport(Darwin)
            return ["/usr/lib/libz.1.dylib"]
        #else
            return ["libz.so.1", "libz.so"]
        #endif
    }()

    static let shared: ZlibLib? = {
        for path in candidates {
            guard let handle = dlopen(path, RTLD_NOW | RTLD_LOCAL) else { continue }
            func sym<T>(_ name: String, as type: T.Type) -> T? {
                guard let raw = dlsym(handle, name) else { return nil }
                return unsafeBitCast(raw, to: T.self)
            }
            guard
                let version = sym("zlibVersion", as: (@convention(c) () -> UnsafePointer<CChar>?).self),
                let dInit = sym(
                    "deflateInit2_",
                    as: (@convention(c) (
                        UnsafeMutableRawPointer?, Int32, Int32, Int32, Int32, Int32, UnsafePointer<CChar>?, Int32
                    ) -> Int32).self),
                let deflate = sym("deflate", as: (@convention(c) (UnsafeMutableRawPointer?, Int32) -> Int32).self),
                let dEnd = sym("deflateEnd", as: (@convention(c) (UnsafeMutableRawPointer?) -> Int32).self),
                let dBound = sym(
                    "deflateBound", as: (@convention(c) (UnsafeMutableRawPointer?, UInt) -> UInt).self),
                let iInit = sym(
                    "inflateInit2_",
                    as: (@convention(c) (UnsafeMutableRawPointer?, Int32, UnsafePointer<CChar>?, Int32) -> Int32)
                        .self),
                let inflate = sym("inflate", as: (@convention(c) (UnsafeMutableRawPointer?, Int32) -> Int32).self),
                let iEnd = sym("inflateEnd", as: (@convention(c) (UnsafeMutableRawPointer?) -> Int32).self)
            else { continue }
            return ZlibLib(
                version: version, deflateInit2: dInit, deflate: deflate, deflateEnd: dEnd,
                deflateBound: dBound, inflateInit2: iInit, inflate: inflate, inflateEnd: iEnd)
        }
        return nil
    }()

    /// Whether a system zlib was found (callers report the miss).
    public static var available: Bool { shared != nil }

    /// Gzip-compress `bytes` (gzip framing, zlib default level 6 / memLevel 8 /
    /// default strategy — the same SETTINGS as `Bun.gzipSync`; see the
    /// byte-parity note above). nil when libz is unavailable or zlib errors.
    public static func compress(_ bytes: [UInt8], level: Int32 = 6) -> [UInt8]? {
        guard let lib = shared else { return nil }
        var stream = ZlibStream()
        let streamSize = Int32(MemoryLayout<ZlibStream>.size)
        let status = withUnsafeMutablePointer(to: &stream) { streamPtr in
            lib.deflateInit2(
                UnsafeMutableRawPointer(streamPtr), level, 8 /* Z_DEFLATED */, gzipEncodeWindowBits,
                8 /* memLevel */, 0 /* Z_DEFAULT_STRATEGY */, lib.version(), streamSize)
        }
        guard status == zOK else { return nil }
        defer {
            _ = withUnsafeMutablePointer(to: &stream) { lib.deflateEnd(UnsafeMutableRawPointer($0)) }
        }

        var input = bytes
        let bound = withUnsafeMutablePointer(to: &stream) {
            lib.deflateBound(UnsafeMutableRawPointer($0), UInt(bytes.count))
        }
        var output = [UInt8](repeating: 0, count: Int(bound) + 64)
        let produced: Int? = input.withUnsafeMutableBufferPointer { inBuf in
            output.withUnsafeMutableBufferPointer { outBuf -> Int? in
                withUnsafeMutablePointer(to: &stream) { streamPtr -> Int? in
                    streamPtr.pointee.nextIn = inBuf.baseAddress
                    streamPtr.pointee.availIn = UInt32(inBuf.count)
                    streamPtr.pointee.nextOut = outBuf.baseAddress
                    streamPtr.pointee.availOut = UInt32(outBuf.count)
                    let result = lib.deflate(UnsafeMutableRawPointer(streamPtr), zFinish)
                    guard result == zStreamEnd else { return nil }
                    return Int(streamPtr.pointee.totalOut)
                }
            }
        }
        guard let produced else { return nil }
        return Array(output[0..<produced])
    }

    /// Gunzip `bytes` (auto-detecting gzip/zlib framing). The shared inflate
    /// the S10 native unzip reuses (raw-deflate callers pass negative
    /// windowBits via `inflateRaw`). nil on a missing libz or corrupt stream.
    public static func decompress(_ bytes: [UInt8]) -> [UInt8]? {
        inflate(bytes, windowBits: gzipDecodeWindowBits)
    }

    /// Raw-deflate inflate (windowBits −15) — zip local-file entries (S10).
    public static func inflateRaw(_ bytes: [UInt8]) -> [UInt8]? {
        inflate(bytes, windowBits: -15)
    }

    private static func inflate(_ bytes: [UInt8], windowBits: Int32) -> [UInt8]? {
        guard let lib = shared, !bytes.isEmpty else { return nil }
        var stream = ZlibStream()
        let streamSize = Int32(MemoryLayout<ZlibStream>.size)
        let status = withUnsafeMutablePointer(to: &stream) {
            lib.inflateInit2(UnsafeMutableRawPointer($0), windowBits, lib.version(), streamSize)
        }
        guard status == zOK else { return nil }
        defer {
            _ = withUnsafeMutablePointer(to: &stream) { lib.inflateEnd(UnsafeMutableRawPointer($0)) }
        }

        var input = bytes
        var out: [UInt8] = []
        var chunk = [UInt8](repeating: 0, count: max(64 * 1024, bytes.count * 4))
        let ok: Bool = input.withUnsafeMutableBufferPointer { inBuf in
            withUnsafeMutablePointer(to: &stream) { streamPtr -> Bool in
                streamPtr.pointee.nextIn = inBuf.baseAddress
                streamPtr.pointee.availIn = UInt32(inBuf.count)
                while true {
                    let result: Int32 = chunk.withUnsafeMutableBufferPointer { chunkBuf in
                        streamPtr.pointee.nextOut = chunkBuf.baseAddress
                        streamPtr.pointee.availOut = UInt32(chunkBuf.count)
                        let r = lib.inflate(UnsafeMutableRawPointer(streamPtr), zNoFlush)
                        let produced = chunkBuf.count - Int(streamPtr.pointee.availOut)
                        if produced > 0 { out.append(contentsOf: chunkBuf[0..<produced]) }
                        return r
                    }
                    if result == zStreamEnd { return true }
                    guard result == zOK else { return false }
                    // Z_OK with no remaining input ⇒ truncated stream.
                    if streamPtr.pointee.availIn == 0 && streamPtr.pointee.availOut != 0 { return false }
                }
            }
        }
        return ok ? out : nil
    }
}

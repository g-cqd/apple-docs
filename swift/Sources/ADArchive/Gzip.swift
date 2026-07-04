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
    let deflateInit2:
        @convention(c) (
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
                    ) -> Int32)
                    .self),
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

    /// The bound library for the streaming inflate (module-internal).
    static var libz: ZlibLib? { shared }

    /// Gzip-compress `bytes` (gzip framing, zlib default level 6 / memLevel 8 /
    /// default strategy — the same SETTINGS as `Bun.gzipSync`; see the
    /// byte-parity note above). nil when libz is unavailable or zlib errors.
    public static func compress(_ bytes: [UInt8], level: Int32 = 6) -> [UInt8]? {
        guard let lib = shared else { return nil }
        // Heap-allocated so the z_stream address is STABLE across calls —
        // zlib's deflateStateCheck compares its state's back-pointer against
        // the pointer passed to every call.
        let streamPtr = UnsafeMutablePointer<ZlibStream>.allocate(capacity: 1)
        streamPtr.initialize(to: ZlibStream())
        defer {
            streamPtr.deinitialize(count: 1)
            streamPtr.deallocate()
        }
        let streamSize = Int32(MemoryLayout<ZlibStream>.size)
        // deflateInit2 magic args (zlib.h): 8 = Z_DEFLATED method, 8 = memLevel, 0 = Z_DEFAULT_STRATEGY.
        let status = lib.deflateInit2(
            UnsafeMutableRawPointer(streamPtr), level, 8, gzipEncodeWindowBits,
            8, 0, lib.version(), streamSize)
        guard status == zOK else { return nil }
        defer { _ = lib.deflateEnd(UnsafeMutableRawPointer(streamPtr)) }

        var input = bytes
        let bound = lib.deflateBound(UnsafeMutableRawPointer(streamPtr), UInt(bytes.count))
        var output = [UInt8](repeating: 0, count: Int(bound) + 64)
        let produced: Int? = input.withUnsafeMutableBufferPointer { inBuf in
            output.withUnsafeMutableBufferPointer { outBuf -> Int? in
                streamPtr.pointee.nextIn = inBuf.baseAddress
                streamPtr.pointee.availIn = UInt32(inBuf.count)
                streamPtr.pointee.nextOut = outBuf.baseAddress
                streamPtr.pointee.availOut = UInt32(outBuf.count)
                let result = lib.deflate(UnsafeMutableRawPointer(streamPtr), zFinish)
                guard result == zStreamEnd else { return nil }
                return Int(streamPtr.pointee.totalOut)
            }
        }
        guard let produced else { return nil }
        return Array(output[0 ..< produced])
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
        guard !bytes.isEmpty, let stream = InflateStream(windowBits: windowBits) else { return nil }
        defer { stream.end() }
        var out: [UInt8] = []
        let result = stream.inflate(bytes) { out.append(contentsOf: $0) }
        return result == .finished ? out : nil
    }
}

/// A chunked inflate over the dlopen'd zlib — the streaming half S10's Unzip
/// extracts multi-GB members through. The z_stream is heap-allocated once
/// (zlib's inflateStateCheck requires a stable address across calls).
final class InflateStream {
    enum Progress {
        case needsMore  // consumed the chunk; the stream continues
        case finished  // Z_STREAM_END reached
        case failed
    }

    private let lib: ZlibLib
    private let streamPtr: UnsafeMutablePointer<ZlibStream>
    private var ended = false

    init?(windowBits: Int32) {
        guard let lib = Gzip.libz else { return nil }
        self.lib = lib
        streamPtr = UnsafeMutablePointer<ZlibStream>.allocate(capacity: 1)
        streamPtr.initialize(to: ZlibStream())
        let status = lib.inflateInit2(
            UnsafeMutableRawPointer(streamPtr), windowBits, lib.version(),
            Int32(MemoryLayout<ZlibStream>.size))
        guard status == 0 else {
            streamPtr.deinitialize(count: 1)
            streamPtr.deallocate()
            return nil
        }
    }

    deinit {
        end()
    }

    /// Release the zlib state (idempotent).
    func end() {
        guard !ended else { return }
        ended = true
        _ = lib.inflateEnd(UnsafeMutableRawPointer(streamPtr))
        streamPtr.deinitialize(count: 1)
        streamPtr.deallocate()
    }

    /// Feed one compressed chunk; `emit` receives each decompressed block.
    func inflate(_ chunk: [UInt8], emit: ([UInt8]) throws -> Void) rethrows -> Progress {
        guard !ended else { return .failed }
        var input = chunk
        var out = [UInt8](repeating: 0, count: 256 * 1024)
        return try input.withUnsafeMutableBufferPointer { inBuf -> Progress in
            streamPtr.pointee.nextIn = inBuf.baseAddress
            streamPtr.pointee.availIn = UInt32(inBuf.count)
            while true {
                var produced = 0
                let result: Int32 = out.withUnsafeMutableBufferPointer { outBuf in
                    streamPtr.pointee.nextOut = outBuf.baseAddress
                    streamPtr.pointee.availOut = UInt32(outBuf.count)
                    let r = lib.inflate(UnsafeMutableRawPointer(streamPtr), 0)  // 0 = Z_NO_FLUSH
                    produced = outBuf.count - Int(streamPtr.pointee.availOut)
                    return r
                }
                if produced > 0 { try emit(Array(out[0 ..< produced])) }
                if result == 1 { return .finished }  // 1 = Z_STREAM_END
                guard result == 0 else { return .failed }  // 0 = Z_OK
                if streamPtr.pointee.availIn == 0 { return .needsMore }
            }
        }
    }
}

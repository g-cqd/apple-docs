// Runtime dlopen/dlsym binding to the system libzstd.
//
// Deliberately NOT a SwiftPM systemLibrary: that would make libzstd a hard
// build dependency of the whole package for every contributor and CI leg.
// dlopen keeps `swift build` zero-dep and degrades exactly like the rest of
// the bridge — library absent → status error → the JS implementation serves.
// The C ABI used here (ZSTD_compressStream2 + parameter API) is stable since
// zstd 1.4.0; the loader refuses anything older.

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

// Layouts mirror zstd.h; all fields are pointer/size_t so there is no
// padding ambiguity.
struct ZstdInBuffer {
  var src: UnsafeRawPointer?
  var size: Int
  var pos: Int
}

struct ZstdOutBuffer {
  var dst: UnsafeMutableRawPointer?
  var size: Int
  var pos: Int
}

// zstd.h stable constants.
enum ZstdParam {
  static let compressionLevel: Int32 = 100
  static let enableLongDistanceMatching: Int32 = 160
  static let contentSizeFlag: Int32 = 200
  static let checksumFlag: Int32 = 201
  static let nbWorkers: Int32 = 400
  static let endContinue: Int32 = 0
  static let endEnd: Int32 = 2
}

struct ZstdLib: @unchecked Sendable {
  let versionNumber: @convention(c) () -> UInt32
  let createCCtx: @convention(c) () -> OpaquePointer?
  let freeCCtx: @convention(c) (OpaquePointer?) -> Int
  let setParameter: @convention(c) (OpaquePointer?, Int32, Int32) -> Int
  let setPledgedSrcSize: @convention(c) (OpaquePointer?, UInt64) -> Int
  let compressStream2:
    @convention(c) (
      OpaquePointer?, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, Int32
    ) -> Int
  let isError: @convention(c) (Int) -> UInt32
  let getErrorName: @convention(c) (Int) -> UnsafePointer<CChar>?
  let cStreamOutSize: @convention(c) () -> Int
  // One-shot decompression (the storage section codec). Context-free —
  // ZSTD_decompress allocates its own DCtx internally; frame content size comes
  // from the frame header (zstd writes it when contentSizeFlag is set, which the
  // compactor does via Bun.zstdCompressSync).
  let decompress: @convention(c) (UnsafeMutableRawPointer?, Int, UnsafeRawPointer?, Int) -> Int
  let getFrameContentSize: @convention(c) (UnsafeRawPointer?, Int) -> UInt64

  func errorName(_ code: Int) -> String {
    guard let cstr = getErrorName(code) else { return "zstd error \(code)" }
    return String(cString: cstr)
  }

  /// Decompresses a complete zstd frame. nil on a malformed frame, an
  /// unknown/oversized content size, or a short write.
  func decompressFrame(_ blob: [UInt8]) -> [UInt8]? {
    guard !blob.isEmpty else { return nil }
    return blob.withUnsafeBytes { src -> [UInt8]? in
      guard let base = src.baseAddress else { return nil }
      let size = getFrameContentSize(base, blob.count)
      // ZSTD_CONTENTSIZE_UNKNOWN == ~0, _ERROR == ~0 - 1; cap to a sane ceiling.
      // 32 MiB dwarfs any real `document_sections.content_text` (KB–low-MB) while
      // bounding the per-frame allocation a crafted/garbled frame can demand
      // across pool threads (CWE-400 decompression amplification).
      guard size < 0xFFFF_FFFF_FFFF_FFFE, size <= 32 << 20 else { return nil }
      let capacity = Int(size)
      if capacity == 0 { return [] }
      var out = [UInt8](repeating: 0, count: capacity)
      let written = out.withUnsafeMutableBytes { dst in
        decompress(dst.baseAddress, capacity, base, blob.count)
      }
      guard isError(written) == 0, written == capacity else { return nil }
      return out
    }
  }
}

/// Public one-shot zstd decompression — the ADStorage section codec inflates
/// zstd-compacted `document_sections.content_text` blobs. nil when libzstd is
/// absent or the frame is malformed (the caller falls back to a raw decode).
public enum ZstdDecoder {
  public static func decompress(_ blob: [UInt8]) -> [UInt8]? {
    Zstd.shared?.decompressFrame(blob)
  }
}

enum Zstd {
  /// Absolute paths on macOS (Apple ships no libzstd; bare names would
  /// honor DYLD_* search). Bare soname is the correct form on Linux.
  private static let candidates: [String] = {
    #if canImport(Darwin)
    return [
      "/opt/homebrew/lib/libzstd.1.dylib",
      "/usr/local/lib/libzstd.1.dylib",
      "/opt/local/lib/libzstd.1.dylib",
    ]
    #else
    return ["libzstd.so.1"]
    #endif
  }()

  static let shared: ZstdLib? = {
    for path in candidates {
      guard let handle = dlopen(path, RTLD_NOW | RTLD_LOCAL) else { continue }
      func sym<T>(_ name: String, as type: T.Type) -> T? {
        guard let raw = dlsym(handle, name) else { return nil }
        return unsafeBitCast(raw, to: T.self)
      }
      guard
        let version = sym("ZSTD_versionNumber", as: (@convention(c) () -> UInt32).self),
        let create = sym("ZSTD_createCCtx", as: (@convention(c) () -> OpaquePointer?).self),
        let free = sym("ZSTD_freeCCtx", as: (@convention(c) (OpaquePointer?) -> Int).self),
        let setParam = sym("ZSTD_CCtx_setParameter", as: (@convention(c) (OpaquePointer?, Int32, Int32) -> Int).self),
        let setPledged = sym("ZSTD_CCtx_setPledgedSrcSize", as: (@convention(c) (OpaquePointer?, UInt64) -> Int).self),
        let stream = sym(
          "ZSTD_compressStream2",
          as: (@convention(c) (OpaquePointer?, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?, Int32) -> Int).self,
        ),
        let isErr = sym("ZSTD_isError", as: (@convention(c) (Int) -> UInt32).self),
        let errName = sym("ZSTD_getErrorName", as: (@convention(c) (Int) -> UnsafePointer<CChar>?).self),
        let outSize = sym("ZSTD_CStreamOutSize", as: (@convention(c) () -> Int).self),
        let decompress = sym(
          "ZSTD_decompress",
          as: (@convention(c) (UnsafeMutableRawPointer?, Int, UnsafeRawPointer?, Int) -> Int).self),
        let frameContentSize = sym(
          "ZSTD_getFrameContentSize",
          as: (@convention(c) (UnsafeRawPointer?, Int) -> UInt64).self)
      else { continue }
      // ZSTD_compressStream2 + the parameter API appeared in 1.4.0.
      guard version() >= 10400 else { continue }
      return ZstdLib(
        versionNumber: version, createCCtx: create, freeCCtx: free,
        setParameter: setParam, setPledgedSrcSize: setPledged,
        compressStream2: stream, isError: isErr, getErrorName: errName,
        cStreamOutSize: outSize, decompress: decompress, getFrameContentSize: frameContentSize,
      )
    }
    return nil
  }()
}

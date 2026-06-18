// Streaming tar.zst writer: one pass per file — synthesized ustar header,
// file bytes, 512 padding — straight through libzstd into the output fd.
// No intermediate .tar (the JS path writes a multi-GB temp tar first).
//
// Determinism: byte-sorted file list supplied by the caller, synthesized
// headers (Tar.swift), and a pinned zstd parameter set — level, workers,
// checksum on (CLI default), long-distance matching off, pledged source
// size (a free integrity check: zstd errors if the tar byte count drifts
// from the pre-pass computation).

#if canImport(Darwin)
import Darwin
private let systemWrite = Darwin.write
#else
import Glibc
private let systemWrite = Glibc.write
#endif

public enum ArchiveFailure: Error {
  case invalid(String)
  case runtime(String)

  public var message: String {
    switch self {
    case .invalid(let m): return m
    case .runtime(let m): return m
    }
  }

  public var isInvalidInput: Bool {
    if case .invalid = self { return true }
    return false
  }
}

public struct ArchiveRequest: Sendable {
  public let sourceDir: String
  public let outputPath: String
  public let files: [String]
  public let level: Int32
  public let workers: Int32

  public init(sourceDir: String, outputPath: String, files: [String], level: Int32, workers: Int32) {
    self.sourceDir = sourceDir
    self.outputPath = outputPath
    self.files = files
    self.level = level
    self.workers = workers
  }
}

public struct ArchiveSuccess: Sendable {
  public let fileCount: Int
  public let size: Int64
  public let zstdVersion: UInt32
}

struct FileMeta {
  let relativePath: String
  let absolutePath: String
  let size: Int64
  let mtime: Int64
  let executable: Bool
}

protocol ByteSink {
  mutating func write(_ bytes: UnsafeRawBufferPointer) throws
  mutating func finish() throws
}

public enum ArchiveWriter {
  public static let maxFiles = 5_000_000

  public static func writeTarZst(_ request: ArchiveRequest) -> Result<ArchiveSuccess, ArchiveFailure> {
    guard let zstd = Zstd.shared else {
      return .failure(.invalid("libzstd >= 1.4.0 not found on this host"))
    }
    guard request.level >= 1, request.level <= 19, request.workers >= 1, request.workers <= 32 else {
      return .failure(.invalid("level/workers out of range (\(request.level)/\(request.workers))"))
    }
    guard request.files.count <= maxFiles else {
      return .failure(.invalid("\(request.files.count) files exceeds the archive cap"))
    }

    // Pre-pass: validate everything before the first output byte — failing
    // at member 250k after minutes of compression is the expensive path.
    let metas: [FileMeta]
    let tarBytes: Int64
    do {
      (metas, tarBytes) = try prepass(request)
    } catch let failure as ArchiveFailure {
      return .failure(failure)
    } catch {
      return .failure(.runtime("\(error)"))
    }

    unlink(request.outputPath)  // start clean, like the JS path
    let outFd = open(request.outputPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    guard outFd >= 0 else {
      return .failure(.runtime("cannot open output \(request.outputPath): errno \(errno)"))
    }

    var sink = ZstdSink(zstd: zstd, fd: outFd)
    do {
      try sink.configure(level: request.level, workers: request.workers, pledgedBytes: UInt64(tarBytes))
      try streamTar(metas: metas, into: &sink)
      try sink.finish()
    } catch {
      sink.teardown()
      close(outFd)
      unlink(request.outputPath)
      if let failure = error as? ArchiveFailure { return .failure(failure) }
      return .failure(.runtime("\(error)"))
    }
    sink.teardown()

    var st = stat()
    let size: Int64 = fstat(outFd, &st) == 0 ? Int64(st.st_size) : -1
    close(outFd)
    return .success(.init(fileCount: metas.count, size: size, zstdVersion: zstd.versionNumber()))
  }

  private static func prepass(_ request: ArchiveRequest) throws -> ([FileMeta], Int64) {
    var metas: [FileMeta] = []
    metas.reserveCapacity(request.files.count)
    var tarBytes: Int64 = 0
    for relative in request.files {
      // Component-wise check: ".." as a path segment is traversal, while
      // "foo..bar" is a legal file name.
      guard !relative.isEmpty, !relative.hasPrefix("/"),
        !relative.split(separator: "/").contains("..")
      else {
        throw ArchiveFailure.invalid("unsafe relative path: \(relative)")
      }
      let absolute = "\(request.sourceDir)/\(relative)"
      var st = stat()
      guard lstat(absolute, &st) == 0 else {
        throw ArchiveFailure.invalid("cannot stat \(relative): errno \(errno)")
      }
      guard (st.st_mode & S_IFMT) == S_IFREG else {
        throw ArchiveFailure.invalid("not a regular file: \(relative)")
      }
      #if canImport(Darwin)
      let mtime = Int64(st.st_mtimespec.tv_sec)
      #else
      let mtime = Int64(st.st_mtim.tv_sec)
      #endif
      guard relative.utf8.count <= 4096 else {
        throw ArchiveFailure.invalid("path exceeds 4096 bytes: \(relative)")
      }
      let meta = FileMeta(
        relativePath: relative,
        absolutePath: absolute,
        size: Int64(st.st_size),
        mtime: mtime,
        executable: (st.st_mode & 0o100) != 0,
      )
      // Representability (size/mtime) + EXACT prelude byte count up front —
      // encodeMember is the single owner of header/pax byte math, so the
      // zstd pledged-size integrity check can never drift from streamTar.
      do {
        let prelude = try Tar.encodeMember(
          path: meta.relativePath, size: meta.size, mtime: meta.mtime,
          executable: meta.executable,
        )
        tarBytes += prelude.reduce(into: Int64(0)) { $0 += Int64($1.count) }
      } catch TarFailure.unrepresentable(let message) {
        throw ArchiveFailure.invalid(message)
      }
      metas.append(meta)
      tarBytes += ((meta.size + 511) / 512) * 512
    }
    tarBytes += 1024  // two zero EOF blocks
    let recordRemainder = tarBytes % Int64(Tar.recordSize)
    if recordRemainder != 0 { tarBytes += Int64(Tar.recordSize) - recordRemainder }
    return (metas, tarBytes)
  }

  /// Streams the full tar byte sequence (headers, bodies, padding, EOF,
  /// record padding) into any sink — tests use a raw sink to inspect the
  /// uncompressed structure.
  static func streamTar(metas: [FileMeta], into sink: inout some ByteSink) throws {
    let zeroes = [UInt8](repeating: 0, count: Tar.recordSize)
    let chunkSize = 1 << 20
    let buffer = UnsafeMutableRawBufferPointer.allocate(byteCount: chunkSize, alignment: 16)
    defer { buffer.deallocate() }
    var produced: Int64 = 0

    func writeZeroes(_ count: Int) throws {
      var remaining = count
      while remaining > 0 {
        let n = min(remaining, zeroes.count)
        try zeroes.withUnsafeBufferPointer { raw in
          try sink.write(UnsafeRawBufferPointer(start: raw.baseAddress, count: n))
        }
        remaining -= n
      }
      produced += Int64(count)
    }

    for meta in metas {
      let prelude = try Tar.encodeMember(
        path: meta.relativePath, size: meta.size, mtime: meta.mtime,
        executable: meta.executable,
      )
      for block in prelude {
        try block.withUnsafeBufferPointer { raw in
          try sink.write(UnsafeRawBufferPointer(raw))
        }
        produced += Int64(block.count)
      }

      let fd = open(meta.absolutePath, O_RDONLY)
      guard fd >= 0 else { throw ArchiveFailure.runtime("cannot open \(meta.relativePath): errno \(errno)") }
      defer { close(fd) }
      var streamed: Int64 = 0
      while true {
        let n = read(fd, buffer.baseAddress, chunkSize)
        if n < 0 {
          if errno == EINTR { continue }  // interrupted by a signal — retry, don't truncate the entry
          throw ArchiveFailure.runtime("read failed for \(meta.relativePath): errno \(errno)")
        }
        if n == 0 { break }
        try sink.write(UnsafeRawBufferPointer(start: buffer.baseAddress, count: n))
        streamed += Int64(n)
        if streamed > meta.size { break }
      }
      // A size drift means the tree mutated mid-build — the header already
      // promised `size` bytes, so the archive would be corrupt.
      guard streamed == meta.size else {
        throw ArchiveFailure.runtime(
          "size changed during archiving for \(meta.relativePath): header \(meta.size), streamed \(streamed)",
        )
      }
      produced += streamed
      let pad = Int((512 - (meta.size % 512)) % 512)
      if pad > 0 { try writeZeroes(pad) }
    }

    try writeZeroes(1024)
    let remainder = Int(produced % Int64(Tar.recordSize))
    if remainder != 0 { try writeZeroes(Tar.recordSize - remainder) }
  }
}

struct ZstdSink: ByteSink {
  let zstd: ZstdLib
  let fd: Int32
  private var cctx: OpaquePointer?
  private var outCapacity = 0
  private var outBuffer: UnsafeMutableRawPointer?

  init(zstd: ZstdLib, fd: Int32) {
    self.zstd = zstd
    self.fd = fd
  }

  mutating func configure(level: Int32, workers: Int32, pledgedBytes: UInt64) throws {
    guard let ctx = zstd.createCCtx() else { throw ArchiveFailure.runtime("ZSTD_createCCtx failed") }
    cctx = ctx
    try set(ZstdParam.compressionLevel, level)
    try set(ZstdParam.checksumFlag, 1)  // match the zstd CLI default
    try set(ZstdParam.enableLongDistanceMatching, 0)
    try set(ZstdParam.contentSizeFlag, 1)
    // A non-MT libzstd build rejects nbWorkers — fail to JS rather than
    // silently dropping to single-pass mode, which changes archive bytes.
    try set(ZstdParam.nbWorkers, workers)
    let pledge = zstd.setPledgedSrcSize(cctx, pledgedBytes)
    guard zstd.isError(pledge) == 0 else {
      throw ArchiveFailure.runtime("pledged size rejected: \(zstd.errorName(pledge))")
    }
    outCapacity = zstd.cStreamOutSize()
    outBuffer = UnsafeMutableRawPointer.allocate(byteCount: outCapacity, alignment: 16)
  }

  private func set(_ parameter: Int32, _ value: Int32) throws {
    let code = zstd.setParameter(cctx, parameter, value)
    guard zstd.isError(code) == 0 else {
      throw ArchiveFailure.runtime("zstd parameter \(parameter)=\(value) rejected: \(zstd.errorName(code))")
    }
  }

  private func flush(_ out: inout ZstdOutBuffer) throws {
    var written = 0
    while written < out.pos {
      let n = systemWrite(fd, out.dst!.advanced(by: written), out.pos - written)
      if n < 0 {
        if errno == EINTR { continue }  // interrupted by a signal — retry the partial write
        throw ArchiveFailure.runtime("output write failed: errno \(errno)")
      }
      guard n > 0 else { throw ArchiveFailure.runtime("output write made no progress") }
      written += n
    }
    out.pos = 0
  }

  mutating func write(_ bytes: UnsafeRawBufferPointer) throws {
    var input = ZstdInBuffer(src: bytes.baseAddress, size: bytes.count, pos: 0)
    var out = ZstdOutBuffer(dst: outBuffer, size: outCapacity, pos: 0)
    while input.pos < input.size {
      let code = withUnsafeMutablePointer(to: &out) { outPtr in
        withUnsafeMutablePointer(to: &input) { inPtr in
          zstd.compressStream2(
            cctx, UnsafeMutableRawPointer(outPtr), UnsafeMutableRawPointer(inPtr), ZstdParam.endContinue)
        }
      }
      guard zstd.isError(code) == 0 else {
        throw ArchiveFailure.runtime("compression failed: \(zstd.errorName(code))")
      }
      if out.pos > 0 { try flush(&out) }
    }
  }

  mutating func finish() throws {
    var input = ZstdInBuffer(src: nil, size: 0, pos: 0)
    var out = ZstdOutBuffer(dst: outBuffer, size: outCapacity, pos: 0)
    while true {
      let code = withUnsafeMutablePointer(to: &out) { outPtr in
        withUnsafeMutablePointer(to: &input) { inPtr in
          zstd.compressStream2(cctx, UnsafeMutableRawPointer(outPtr), UnsafeMutableRawPointer(inPtr), ZstdParam.endEnd)
        }
      }
      guard zstd.isError(code) == 0 else {
        throw ArchiveFailure.runtime("finalize failed: \(zstd.errorName(code))")
      }
      if out.pos > 0 { try flush(&out) }
      if code == 0 { break }
    }
  }

  mutating func teardown() {
    if cctx != nil {
      _ = zstd.freeCCtx(cctx)
      cctx = nil
    }
    outBuffer?.deallocate()
    outBuffer = nil
  }
}

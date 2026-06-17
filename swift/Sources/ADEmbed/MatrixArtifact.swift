// ADMX v1 weights-artifact reader — read-only mmap,
// Foundation-free (raw Darwin/Glibc syscalls, ADArchive house style).
//
// Layout (u32 LE integers; produced by scripts/gen-embed-matrix.mjs):
//   magic 'ADMX' | version=1 | flags (bit0 = sparse) | dtype=1 (f32 LE)
//   rows | dims | reserved ×2 | sourceSha256 (32 raw bytes of model.onnx)
//   [sparse] rows × u32 ascending token ids
//   zero-pad to 64-byte boundary | rows × dims × f32 LE row-major
//
// The matrix is mapped, never heap-copied. Row pointers stay valid for the
// lifetime of this object. f32 payload is read as host-endian — both
// supported targets (arm64, x86_64) are little-endian; header integers go
// through UInt32(littleEndian:) regardless.

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public final class MatrixArtifact: @unchecked Sendable {
  // @unchecked: the mapping is immutable (PROT_READ) and all stored
  // properties are lets — safe to share across threads.

  public enum LoadError: Error, Equatable {
    case openFailed(errno: Int32)
    case mapFailed(errno: Int32)
    case tooSmall
    case badMagic
    case unsupportedVersion(UInt32)
    case unsupportedDtype(UInt32)
    case truncated
    case idTableNotAscending
  }

  public let rows: Int
  public let dims: Int
  public let isSparse: Bool
  public let sourceSha256: [UInt8]

  private let base: UnsafeMutableRawPointer
  private let length: Int
  private let idTableOffset: Int
  private let dataOffset: Int

  private static let headerBytes = 64

  public init(path: String) throws(LoadError) {
    let fd = path.withCString { openFile($0, O_RDONLY) }
    guard fd >= 0 else { throw .openFailed(errno: errno) }
    defer { _ = closeFile(fd) }

    var info = stat()
    guard fstat(fd, &info) == 0 else { throw .openFailed(errno: errno) }
    let length = Int(info.st_size)
    guard length >= Self.headerBytes else { throw .tooSmall }

    // MAP_FAILED is a C macro ((void *)-1) that Glibc does not import.
    guard let mapped = mmap(nil, length, PROT_READ, MAP_PRIVATE, fd, 0),
      mapped != UnsafeMutableRawPointer(bitPattern: -1)
    else { throw .mapFailed(errno: errno) }
    // From here on the mapping must be released on every failure path.
    func fail(_ error: LoadError) -> LoadError {
      munmap(mapped, length)
      return error
    }

    func u32(_ offset: Int) -> UInt32 {
      UInt32(littleEndian: mapped.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
    }

    guard u32(0) == 0x584D_4441 else { throw fail(.badMagic) }  // 'ADMX' LE
    let version = u32(4)
    guard version == 1 else { throw fail(.unsupportedVersion(version)) }
    let flags = u32(8)
    let dtype = u32(12)
    guard dtype == 1 else { throw fail(.unsupportedDtype(dtype)) }
    let rows = Int(u32(16))
    let dims = Int(u32(20))
    let isSparse = flags & 1 == 1

    let idTableBytes = isSparse ? rows * 4 : 0
    let dataOffset = (Self.headerBytes + idTableBytes + 63) / 64 * 64
    guard length == dataOffset + rows * dims * 4 else { throw fail(.truncated) }

    if isSparse {
      var previous: UInt32 = 0
      for i in 0..<rows {
        let id = u32(Self.headerBytes + i * 4)
        guard i == 0 || id > previous else { throw fail(.idTableNotAscending) }
        previous = id
      }
    }

    self.base = mapped
    self.length = length
    self.rows = rows
    self.dims = dims
    self.isSparse = isSparse
    self.idTableOffset = Self.headerBytes
    self.dataOffset = dataOffset
    var sha = [UInt8](repeating: 0, count: 32)
    for i in 0..<32 { sha[i] = mapped.loadUnaligned(fromByteOffset: 32 + i, as: UInt8.self) }
    self.sourceSha256 = sha
  }

  deinit {
    munmap(base, length)
  }

  /// Pointer to the 4-byte-aligned f32 row for `tokenId`, or nil when the
  /// id is absent (sparse miss / dense out-of-range). Never traps.
  ///
  /// Lifetime contract: the pointer aliases the read-only mmap and is valid
  /// ONLY while this `MatrixArtifact` is alive — `deinit` `munmap`s the region,
  /// after which it dangles. It addresses exactly `dims` contiguous `Float`s
  /// (one row); anything past that is out of bounds. Consume it within the
  /// artifact's lifetime; never store it beyond.
  public func row(forTokenId id: UInt32) -> UnsafePointer<Float>? {
    let index: Int
    if isSparse {
      var lo = 0
      var hi = rows - 1
      var found = -1
      while lo <= hi {
        let mid = (lo + hi) / 2
        let value = UInt32(littleEndian: base.loadUnaligned(fromByteOffset: idTableOffset + mid * 4, as: UInt32.self))
        if value < id {
          lo = mid + 1
        } else if value > id {
          hi = mid - 1
        } else {
          found = mid
          break
        }
      }
      guard found >= 0 else { return nil }
      index = found
    } else {
      guard id < UInt32(rows) else { return nil }
      index = Int(id)
    }
    return UnsafePointer((base + dataOffset + index * dims * 4).assumingMemoryBound(to: Float.self))
  }
}

// Darwin/Glibc both expose open/close; alias them so the initializer's
// control flow reads unambiguously.
private func openFile(_ path: UnsafePointer<CChar>, _ flags: Int32) -> Int32 {
  open(path, flags)
}

private func closeFile(_ fd: Int32) -> Int32 {
  close(fd)
}

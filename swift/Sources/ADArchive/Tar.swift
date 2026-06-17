// Deterministic ustar + pax header writer.
//
// Headers are fully synthesized — mode clamped to 0644/0755, uid/gid 0,
// uname/gname "root" — so archive bytes never depend on the build host's
// user or umask (the JS tar path leaks both; extraction always runs with
// --no-same-owner --no-same-permissions, so the clamp is invisible there).
//
// Paths that fit the ustar 155+100 split get a single classic header.
// Longer paths get a POSIX.1-2001 pax extended header (typeflag 'x', one
// `<len> path=<value>\n` record, data NUL-padded to 512) followed by the
// file header carrying a byte-truncated name that pax overrides — the
// production corpus carries SF Symbols SVGs whose FILENAME alone exceeds
// 100 bytes, which no split can represent. Everything stays deterministic:
// the pax member's own name is `PaxHeaders/<basename>` truncated to 100
// (the GNU reproducible-builds convention; extractors read the record, so
// uniqueness is not required), and its mtime is the member's synthesized
// mtime. Sizes/mtimes outside octal range remain hard validation errors.

enum TarFailure: Error {
  case unrepresentable(String)
}

enum Tar {
  static let blockSize = 512
  static let recordSize = 10240
  static let maxFileSize: Int64 = (1 << 33) - 1  // 8 GiB − 1: 11 octal digits

  /// Splits a relative path into (prefix, name) per ustar rules, on UTF-8
  /// byte lengths. Throws when no split fits (name > 100 with no usable
  /// `/`, prefix > 155, or any single component > 100) — encodeMember
  /// catches that and emits a pax header instead.
  static func splitName(_ path: String) throws(TarFailure) -> (prefix: [UInt8], name: [UInt8]) {
    let bytes = Array(path.utf8)
    if bytes.count <= 100 { return ([], bytes) }
    // Rightmost split where suffix ≤ 100 and prefix ≤ 155; the slash
    // separating them is not stored.
    var index = bytes.count - 1
    while index > 0 {
      if bytes[index] == UInt8(ascii: "/") {
        let prefix = Array(bytes[0..<index])
        let name = Array(bytes[(index + 1)...])
        if name.count <= 100 && prefix.count <= 155 && !name.isEmpty {
          return (prefix, name)
        }
        if prefix.count > 155 { break }
      }
      index -= 1
    }
    throw TarFailure.unrepresentable("path does not fit ustar 155+100 split: \(path)")
  }

  /// One pax record: `<len> path=<value>\n` where len counts the WHOLE
  /// line — its own decimal digits included (POSIX fixed point; note the
  /// gap values: e.g. a 91-byte path admits 101 but never 100).
  static func paxPathRecord(_ pathBytes: [UInt8]) -> [UInt8] {
    // space + "path=" + newline around the value.
    let fixed = 1 + 5 + 1 + pathBytes.count
    var length = fixed + 1
    while String(length).utf8.count + fixed != length {
      length = String(length).utf8.count + fixed
    }
    var record = Array("\(length) path=".utf8)
    record.append(contentsOf: pathBytes)
    record.append(UInt8(ascii: "\n"))
    return record
  }

  /// All 512-byte blocks that precede a member's file data. ONE owner of
  /// the byte math: the prepass accounting and the stream writer both call
  /// this, so the zstd pledged-size integrity check can never drift.
  static func encodeMember(
    path: String, size: Int64, mtime: Int64, executable: Bool
  ) throws(TarFailure) -> [[UInt8]] {
    guard size >= 0, size <= maxFileSize else {
      throw TarFailure.unrepresentable("size \(size) outside ustar range: \(path)")
    }
    guard mtime >= 0, mtime <= 0o77777777777 else {
      throw TarFailure.unrepresentable("mtime \(mtime) outside ustar octal range: \(path)")
    }
    let mode: UInt64 = executable ? 0o755 : 0o644
    if let (prefix, name) = try? splitName(path) {
      return [
        headerBlock(name: name, prefix: prefix, size: size, mtime: mtime, mode: mode, typeflag: UInt8(ascii: "0"))
      ]
    }

    // pax path: extended header + padded record data + the real header
    // under a truncated name that the `path=` record overrides.
    let pathBytes = Array(path.utf8)
    let record = paxPathRecord(pathBytes)
    let basenameStart = (pathBytes.lastIndex(of: UInt8(ascii: "/")).map { $0 + 1 }) ?? 0
    var paxName = Array("PaxHeaders/".utf8)
    paxName.append(contentsOf: pathBytes[basenameStart...])
    if paxName.count > 100 { paxName = Array(paxName[0..<100]) }
    let truncated = Array(pathBytes.prefix(100))

    var blocks: [[UInt8]] = []
    blocks.append(
      headerBlock(
        name: paxName, prefix: [], size: Int64(record.count), mtime: mtime, mode: 0o644,
        typeflag: UInt8(ascii: "x"),
      ))
    var data = record
    let padded = (record.count + blockSize - 1) / blockSize * blockSize
    data.append(contentsOf: [UInt8](repeating: 0, count: padded - record.count))
    blocks.append(data)
    blocks.append(
      headerBlock(name: truncated, prefix: [], size: size, mtime: mtime, mode: mode, typeflag: UInt8(ascii: "0"))
    )
    return blocks
  }

  /// Backward-compatible single-header writer for paths that fit ustar.
  static func writeHeader(
    into block: inout [UInt8], path: String, size: Int64, mtime: Int64, executable: Bool
  ) throws(TarFailure) {
    guard size >= 0, size <= maxFileSize else {
      throw TarFailure.unrepresentable("size \(size) outside ustar range: \(path)")
    }
    guard mtime >= 0, mtime <= 0o77777777777 else {
      throw TarFailure.unrepresentable("mtime \(mtime) outside ustar octal range: \(path)")
    }
    let (prefix, name) = try splitName(path)
    let encoded = headerBlock(
      name: name, prefix: prefix, size: size, mtime: mtime,
      mode: executable ? 0o755 : 0o644, typeflag: UInt8(ascii: "0"),
    )
    for i in 0..<blockSize { block[i] = encoded[i] }
  }

  /// Synthesized 512-byte header. Callers guarantee field ranges.
  private static func headerBlock(
    name: [UInt8], prefix: [UInt8], size: Int64, mtime: Int64, mode: UInt64, typeflag: UInt8
  ) -> [UInt8] {
    var block = [UInt8](repeating: 0, count: blockSize)

    func put(_ bytes: [UInt8], at offset: Int) {
      for (i, b) in bytes.enumerated() { block[offset + i] = b }
    }
    func putOctal(_ value: UInt64, width: Int, at offset: Int) {
      // width-1 octal digits, zero-padded, NUL terminated (classic format).
      var digits = [UInt8](repeating: UInt8(ascii: "0"), count: width - 1)
      var v = value
      var i = width - 2
      while v > 0 && i >= 0 {
        digits[i] = UInt8(ascii: "0") + UInt8(v & 7)
        v >>= 3
        i -= 1
      }
      put(digits, at: offset)
      block[offset + width - 1] = 0
    }

    put(name, at: 0)  // name[100]
    putOctal(mode, width: 8, at: 100)
    putOctal(0, width: 8, at: 108)  // uid
    putOctal(0, width: 8, at: 116)  // gid
    putOctal(UInt64(size), width: 12, at: 124)
    putOctal(UInt64(mtime), width: 12, at: 136)
    // chksum[8] is spaces while summing.
    for i in 148..<156 { block[i] = UInt8(ascii: " ") }
    block[156] = typeflag
    // linkname[100] stays zero.
    put(Array("ustar".utf8), at: 257)  // magic "ustar\0"
    block[262] = 0
    block[263] = UInt8(ascii: "0")  // version "00"
    block[264] = UInt8(ascii: "0")
    put(Array("root".utf8), at: 265)  // uname[32]
    put(Array("root".utf8), at: 297)  // gname[32]
    putOctal(0, width: 8, at: 329)  // devmajor
    putOctal(0, width: 8, at: 337)  // devminor
    put(prefix, at: 345)  // prefix[155]

    var checksum = 0
    for i in 0..<blockSize { checksum += Int(block[i]) }
    // chksum: 6 octal digits, NUL, space — the classic interop encoding.
    var digits = [UInt8](repeating: UInt8(ascii: "0"), count: 6)
    var v = checksum
    var i = 5
    while v > 0 && i >= 0 {
      digits[i] = UInt8(ascii: "0") + UInt8(v & 7)
      v >>= 3
      i -= 1
    }
    put(digits, at: 148)
    block[154] = 0
    block[155] = UInt8(ascii: " ")
    return block
  }
}

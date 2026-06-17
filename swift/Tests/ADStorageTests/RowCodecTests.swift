// Pins the per-cell type-tagged row framing that the JS shim decodes back
// into bun:sqlite-identical row objects. Self-contained: seeds a tiny table
// on a raw read-write connection (Connection itself is query_only), then
// frames a SELECT and decodes the bytes. The full searchPages/FTS5 path is
// gated by the JS A/B test against the real corpus schema.

import Testing

@testable import ADStorage

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

private enum Cell: Equatable {
  case null
  case int(Int64)
  case real(Double)
  case text(String)
  case blob([UInt8])
}

private struct Decoded {
  var columnCount: Int
  var rows: [[Cell]]
}

private func decode(_ bytes: [UInt8]) -> Decoded {
  var off = 0
  func u32() -> UInt32 {
    let v =
      UInt32(bytes[off]) | UInt32(bytes[off + 1]) << 8 | UInt32(bytes[off + 2]) << 16
      | UInt32(bytes[off + 3]) << 24
    off += 4
    return v
  }
  func i64() -> Int64 {
    var v: UInt64 = 0
    for i in 0..<8 { v |= UInt64(bytes[off + i]) << (8 * i) }
    off += 8
    return Int64(bitPattern: v)
  }
  let columnCount = Int(u32())
  let rowCount = Int(u32())
  var rows: [[Cell]] = []
  for _ in 0..<rowCount {
    var row: [Cell] = []
    for _ in 0..<columnCount {
      let tag = bytes[off]
      off += 1
      switch tag {
      case 0: row.append(.null)
      case 1: row.append(.int(i64()))
      case 2: row.append(.real(Double(bitPattern: UInt64(bitPattern: i64()))))
      case 3:
        let n = Int(u32())
        row.append(.text(String(decoding: bytes[off..<off + n], as: UTF8.self)))
        off += n
      case 4:
        let n = Int(u32())
        row.append(.blob(Array(bytes[off..<off + n])))
        off += n
      default: fatalError("bad tag \(tag)")
      }
    }
    rows.append(row)
  }
  return Decoded(columnCount: columnCount, rows: rows)
}

@Suite struct RowCodecTests {
  @Test func sqliteLoadsWithFTS5() {
    // The build host's libsqlite3 must load; FTS5 is verified per-connection
    // in Connection.init, not here.
    #expect(SQLiteLoader.shared != nil)
  }

  @Test func framesEveryColumnType() throws {
    let lib = try #require(SQLiteLoader.shared)
    let path = "/tmp/adstorage-\(UInt64.random(in: 0..<UInt64.max)).db"
    defer { unlink(path) }

    var raw: OpaquePointer?
    let rc = path.withCString {
      lib.openV2($0, &raw, SQLite.openReadWrite | SQLite.openCreate | SQLite.openNoMutex, nil)
    }
    #expect(rc == SQLite.ok)
    let db = try #require(raw)
    defer { _ = lib.closeV2(db) }

    func exec(_ sql: String) {
      let s = PreparedStatement(lib: lib, db: db, sql: sql)
      #expect(s != nil)
      _ = lib.step(s!.stmt)
    }
    exec("CREATE TABLE t(i INTEGER, r REAL, s TEXT, n, b BLOB)")
    exec("INSERT INTO t VALUES (42, 3.5, 'héllo', NULL, x'00ff')")
    exec("INSERT INTO t VALUES (-7, 0.0, '', NULL, NULL)")

    let stmt = try #require(PreparedStatement(lib: lib, db: db, sql: "SELECT i, r, s, n, b FROM t ORDER BY i DESC"))
    var out: [UInt8] = []
    #expect(stmt.run(into: &out))
    let d = decode(out)
    #expect(d.columnCount == 5)
    #expect(d.rows.count == 2)
    #expect(d.rows[0] == [.int(42), .real(3.5), .text("héllo"), .null, .blob([0x00, 0xff])])
    #expect(d.rows[1] == [.int(-7), .real(0.0), .text(""), .null, .null])

    // Re-run the same statement: reset + clear_bindings must yield identical
    // rows (no leaked state).
    var again: [UInt8] = []
    #expect(stmt.run(into: &again))
    #expect(again == out)
  }
}

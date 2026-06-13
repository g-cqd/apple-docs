// A cached sqlite3_stmt wrapper. One statement per SQL string, owned by a
// Connection, reused across calls. reset + clear_bindings run on teardown
// of every execution (bun:sqlite does this implicitly) so stale bindings
// from a prior call can never leak into the next and silently return wrong
// rows.

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// A bound value for a named parameter. `.null` binds SQL NULL.
enum BindValue {
  case null
  case int(Int64)
  case double(Double)
  case text(String)
}

final class PreparedStatement {
  private let lib: SQLiteLib
  private let db: OpaquePointer
  let stmt: OpaquePointer

  init?(lib: SQLiteLib, db: OpaquePointer, sql: String) {
    self.lib = lib
    self.db = db
    var handle: OpaquePointer?
    let rc = sql.withCString { cstr in
      lib.prepareV2(db, cstr, -1, &handle, nil)
    }
    guard rc == SQLite.ok, let handle else {
      if let handle { _ = lib.finalize(handle) }
      return nil
    }
    self.stmt = handle
  }

  deinit {
    _ = lib.finalize(stmt)
  }

  /// Binds a value to the named parameter (e.g. "$query"). Unknown names
  /// are ignored (index 0) — the SQL simply has no such placeholder.
  func bind(_ name: String, _ value: BindValue) {
    let idx = name.withCString { lib.bindParameterIndex(stmt, $0) }
    guard idx > 0 else { return }
    switch value {
    case .null:
      _ = lib.bindNull(stmt, idx)
    case .int(let v):
      _ = lib.bindInt64(stmt, idx, v)
    case .double(let v):
      _ = lib.bindDouble(stmt, idx, v)
    case .text(let s):
      let bytes = Array(s.utf8)
      bytes.withUnsafeBufferPointer { buf in
        // SQLITE_TRANSIENT: sqlite copies the bytes during this call, so the
        // local `bytes` lifetime is sufficient.
        _ = lib.bindText(stmt, idx, buf.baseAddress, Int32(buf.count), sqliteTransient)
      }
    }
  }

  /// Steps the statement to completion, framing every result row into `out`
  /// as `[u32 columnCount][u32 rowCount]` then per row `columnCount` cells,
  /// each `[u8 tag][value]`:
  ///   tag 0 NULL (no value), 1 INTEGER [i64 LE], 2 REAL [f64 LE],
  ///   3 TEXT [u32 len][utf8], 4 BLOB [u32 len][bytes].
  /// This mirrors sqlite3_column_type's dynamic mapping exactly, so the JS
  /// decoder reproduces bun:sqlite's null/number/string/Uint8Array values
  /// byte-for-byte. Returns false on a step error (→ JS fallback). Always
  /// resets + clears bindings before returning.
  func run(into out: inout [UInt8]) -> Bool {
    defer {
      _ = lib.reset(stmt)
      _ = lib.clearBindings(stmt)
    }
    let columnCount = lib.columnCount(stmt)
    let columnHeaderOffset = out.count
    appendU32(&out, UInt32(bitPattern: columnCount))
    appendU32(&out, 0)  // rowCount placeholder, patched after stepping
    var rowCount: UInt32 = 0
    while true {
      let rc = lib.step(stmt)
      if rc == SQLite.done { break }
      guard rc == SQLite.row else { return false }
      for col in 0..<columnCount {
        appendCell(&out, column: col)
      }
      rowCount &+= 1
    }
    patchU32(&out, at: columnHeaderOffset + 4, rowCount)
    return true
  }

  private func appendCell(_ out: inout [UInt8], column col: Int32) {
    switch lib.columnType(stmt, col) {
    case SQLite.typeInteger:
      out.append(1)
      appendI64(&out, lib.columnInt64(stmt, col))
    case SQLite.typeFloat:
      out.append(2)
      appendF64(&out, lib.columnDouble(stmt, col))
    case SQLite.typeText:
      out.append(3)
      // column_text first, then column_bytes returns the utf8 byte count.
      let ptr = lib.columnText(stmt, col)
      let n = Int(lib.columnBytes(stmt, col))
      appendU32(&out, UInt32(n))
      if n > 0, let ptr {
        out.append(contentsOf: UnsafeBufferPointer(start: ptr, count: n))
      }
    case SQLite.typeBlob:
      out.append(4)
      let ptr = lib.columnBlob(stmt, col)
      let n = Int(lib.columnBytes(stmt, col))
      appendU32(&out, UInt32(n))
      if n > 0, let ptr {
        out.append(
          contentsOf: UnsafeRawBufferPointer(start: ptr, count: n).bindMemory(to: UInt8.self))
      }
    default:  // SQLITE_NULL
      out.append(0)
    }
  }
}

// MARK: - little-endian byte appenders

func appendU32(_ out: inout [UInt8], _ value: UInt32) {
  var le = value.littleEndian
  withUnsafeBytes(of: &le) { out.append(contentsOf: $0) }
}

func appendI64(_ out: inout [UInt8], _ value: Int64) {
  var le = value.littleEndian
  withUnsafeBytes(of: &le) { out.append(contentsOf: $0) }
}

func appendU64(_ out: inout [UInt8], _ value: UInt64) {
  var le = value.littleEndian
  withUnsafeBytes(of: &le) { out.append(contentsOf: $0) }
}

func appendF64(_ out: inout [UInt8], _ value: Double) {
  appendU64(&out, value.bitPattern)
}

func patchU32(_ out: inout [UInt8], at offset: Int, _ value: UInt32) {
  let le = value.littleEndian
  withUnsafeBytes(of: le) { bytes in
    for i in 0..<4 { out[offset + i] = bytes[i] }
  }
}

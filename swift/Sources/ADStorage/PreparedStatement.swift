// A cached sqlite3_stmt wrapper. One statement per SQL string, owned by a
// Connection, reused across calls. reset + clear_bindings run on teardown
// of every execution so stale bindings from a prior call can never leak
// into the next and silently return wrong rows.

import ADJSONCore

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
    // Column-name bytes are constant for a prepared statement — collect once on
    // first runJSON (avoids ~N String allocations per call).
    private var jsonNames: [[UInt8]]?

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
    /// This mirrors sqlite3_column_type's dynamic mapping exactly. Returns
    /// false on a step error. Always resets + clears bindings before returning.
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
            for col in 0 ..< columnCount {
                appendCell(&out, column: col)
            }
            rowCount &+= 1
        }
        patchU32(&out, at: columnHeaderOffset + 4, rowCount)
        return true
    }

    /// Steps to completion, framing rows as a JSON array of objects keyed by
    /// column name — hand-rolled to `out` (NO Foundation; JSONEncoder is ~57×
    /// slower on Linux). Per-cell typing: NULL/BLOB → null, INTEGER/REAL →
    /// number, TEXT → escaped string. Returns false on a step error. Always
    /// resets + clears bindings.
    func runJSON(into out: inout [UInt8]) -> Bool {
        defer {
            _ = lib.reset(stmt)
            _ = lib.clearBindings(stmt)
        }
        let columnCount = lib.columnCount(stmt)
        let names: [[UInt8]]
        if let cached = jsonNames {
            names = cached
        } else {
            var collected: [[UInt8]] = []
            collected.reserveCapacity(Int(columnCount))
            for i in 0 ..< columnCount {
                collected.append(lib.columnName(stmt, i).map { Array(String(cString: $0).utf8) } ?? [])
            }
            jsonNames = collected
            names = collected
        }
        out.append(UInt8(ascii: "["))
        var firstRow = true
        while true {
            let rc = lib.step(stmt)
            if rc == SQLite.done { break }
            guard rc == SQLite.row else { return false }
            if !firstRow { out.append(UInt8(ascii: ",")) }
            firstRow = false
            out.append(UInt8(ascii: "{"))
            for col in 0 ..< columnCount {
                if col > 0 { out.append(UInt8(ascii: ",")) }
                out.append(UInt8(ascii: "\""))
                names[Int(col)].withUnsafeBufferPointer { appendJSONEscaped(&out, $0) }
                out.append(UInt8(ascii: "\""))
                out.append(UInt8(ascii: ":"))
                appendJSONCell(&out, column: col)
            }
            out.append(UInt8(ascii: "}"))
        }
        out.append(UInt8(ascii: "]"))
        return true
    }

    // MARK: - row iteration (for the in-process cascade)

    /// Steps once; returns the raw sqlite rc (SQLite.row / .done / error).
    func step() -> Int32 { lib.step(stmt) }

    /// Resets + clears bindings (call after a step loop).
    func reset() {
        _ = lib.reset(stmt)
        _ = lib.clearBindings(stmt)
    }

    func columnCount() -> Int32 { lib.columnCount(stmt) }

    func isNull(_ col: Int32) -> Bool { lib.columnType(stmt, col) == SQLite.typeNull }

    /// The dynamic SQLite type of a result column (SQLite.type*). Used by the
    /// section codec to distinguish a TEXT cell (pass through) from a BLOB
    /// (zstd-compacted) one.
    func columnType(_ col: Int32) -> Int32 { lib.columnType(stmt, col) }

    /// Raw BLOB bytes of a result column, or nil when NULL.
    func blob(_ col: Int32) -> [UInt8]? {
        guard lib.columnType(stmt, col) != SQLite.typeNull, let ptr = lib.columnBlob(stmt, col) else {
            return nil
        }
        let n = Int(lib.columnBytes(stmt, col))
        guard n > 0 else { return [] }
        return Array(UnsafeRawBufferPointer(start: ptr, count: n).bindMemory(to: UInt8.self))
    }

    /// Binds a String to a positional (1-based) `?` parameter. SQLITE_TRANSIENT:
    /// sqlite copies the bytes during the call.
    func bindText(_ index: Int32, _ value: String) {
        let bytes = Array(value.utf8)
        bytes.withUnsafeBufferPointer { buf in
            _ = lib.bindText(stmt, index, buf.baseAddress, Int32(buf.count), sqliteTransient)
        }
    }

    /// Binds an Int64 to a positional (1-based) `?` parameter.
    func bindInt64(_ index: Int32, _ value: Int64) {
        _ = lib.bindInt64(stmt, index, value)
    }

    func text(_ col: Int32) -> String? {
        guard lib.columnType(stmt, col) != SQLite.typeNull, let ptr = lib.columnText(stmt, col) else {
            return nil
        }
        let n = Int(lib.columnBytes(stmt, col))
        return String(decoding: UnsafeBufferPointer(start: ptr, count: n), as: UTF8.self)
    }

    func int(_ col: Int32) -> Int64? {
        lib.columnType(stmt, col) == SQLite.typeNull ? nil : lib.columnInt64(stmt, col)
    }

    func double(_ col: Int32) -> Double? {
        lib.columnType(stmt, col) == SQLite.typeNull ? nil : lib.columnDouble(stmt, col)
    }

    private func appendJSONCell(_ out: inout [UInt8], column col: Int32) {
        switch lib.columnType(stmt, col) {
            case SQLite.typeInteger:
                appendInt(&out, lib.columnInt64(stmt, col))
            case SQLite.typeFloat:
                let d = lib.columnDouble(stmt, col)
                out.append(contentsOf: (d.isFinite ? String(d) : "null").utf8)
            case SQLite.typeText:
                let ptr = lib.columnText(stmt, col)
                let n = Int(lib.columnBytes(stmt, col))
                out.append(UInt8(ascii: "\""))
                if n > 0, let ptr { appendJSONEscaped(&out, UnsafeBufferPointer(start: ptr, count: n)) }
                out.append(UInt8(ascii: "\""))
            default:  // NULL or BLOB (searchPages projects neither)
                out.append(contentsOf: "null".utf8)
        }
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
        for i in 0 ..< 4 { out[offset + i] = bytes[i] }
    }
}

/// Appends the base-10 ASCII of an Int64 with no heap allocation.
func appendInt(_ out: inout [UInt8], _ value: Int64) {
    if value == 0 {
        out.append(UInt8(ascii: "0"))
        return
    }
    let negative = value < 0
    var mag = negative ? (0 &- UInt64(bitPattern: value)) : UInt64(bitPattern: value)
    withUnsafeTemporaryAllocation(of: UInt8.self, capacity: 20) { scratch in
        var i = 20
        while mag > 0 {
            i -= 1
            scratch[i] = UInt8(ascii: "0") + UInt8(mag % 10)
            mag /= 10
        }
        if negative { out.append(UInt8(ascii: "-")) }
        for j in i ..< 20 { out.append(scratch[j]) }
    }
}

// MARK: - JSON string escaping (delegated to ADJSON's single escaper); UTF-8 bytes pass through.

func appendJSONEscaped(_ out: inout [UInt8], _ buf: UnsafeBufferPointer<UInt8>) {
    for b in buf {
        if b < 0x20 || b == 0x22 || b == 0x5C {
            JSONOutput.appendEscape(b, to: &out)
        } else {
            out.append(b)
        }
    }
}

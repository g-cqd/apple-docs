// The libsqlite3 `StorageStatement`. A cached sqlite3_stmt wrapper: one
// statement per SQL string, owned by a `SQLiteConnection`, reused across calls.
// reset + clear_bindings run on teardown of every execution so stale bindings
// from a prior call can never leak into the next and silently return wrong rows.
//
// `run`/`runJSON` are the shared `RowFraming` defaults (StorageStatement.swift):
// this type only supplies the accessors + the zero-copy text/blob byte hooks,
// so the framing loop lives in one place.

import ADFCore
import ADJSONCore

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

final class SQLiteStatement: StorageStatement {
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

    /// Binds a value to the named parameter (e.g. "$query"). Unknown names are
    /// ignored (index 0) — the SQL simply has no such placeholder.
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

    // MARK: - row iteration

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
    /// (zstd-compacted) one, and by the shared framer.
    func columnType(_ col: Int32) -> Int32 { lib.columnType(stmt, col) }

    /// The result column's name (`sqlite3_column_name`) — the dynamic-row
    /// readers (fonts JSON parity) key cells by it in SELECT * column order.
    func columnName(_ col: Int32) -> String? {
        lib.columnName(stmt, col).map { String(cString: $0) }
    }

    /// Raw BLOB bytes of a result column, or nil when NULL.
    func blob(_ col: Int32) -> [UInt8]? {
        guard lib.columnType(stmt, col) != SQLite.typeNull, let ptr = lib.columnBlob(stmt, col) else {
            return nil
        }
        let n = Int(lib.columnBytes(stmt, col))
        guard n > 0 else { return [] }
        return Array(UnsafeRawBufferPointer(start: ptr, count: n).bindMemory(to: UInt8.self))
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

    // MARK: - zero-copy byte access for the shared framer

    /// column_text first, then column_bytes returns the utf8 byte count — the
    /// same order the framed TEXT cell used inline.
    func withColumnTextBytes(_ col: Int32, _ body: (UnsafeBufferPointer<UInt8>) -> Void) {
        let ptr = lib.columnText(stmt, col)
        let n = Int(lib.columnBytes(stmt, col))
        if let ptr, n > 0 {
            body(UnsafeBufferPointer(start: ptr, count: n))
        } else {
            body(UnsafeBufferPointer(start: nil, count: 0))
        }
    }

    func withColumnBlobBytes(_ col: Int32, _ body: (UnsafeBufferPointer<UInt8>) -> Void) {
        let ptr = lib.columnBlob(stmt, col)
        let n = Int(lib.columnBytes(stmt, col))
        if let ptr, n > 0 {
            body(UnsafeRawBufferPointer(start: ptr, count: n).bindMemory(to: UInt8.self))
        } else {
            body(UnsafeBufferPointer(start: nil, count: 0))
        }
    }
}

// MARK: - little-endian byte appenders (delegated to ADFCore's canonical endian primitives)

// One LE encoder for the whole family lives in `ADFCore.Endian`; these keep the local call-site
// names but route through it (byte-identical — the response frame's wire layout is unchanged).
func appendU32(_ out: inout [UInt8], _ value: UInt32) { out.appendLE32(value) }

func appendI64(_ out: inout [UInt8], _ value: Int64) { out.appendLE64(UInt64(bitPattern: value)) }

func appendU64(_ out: inout [UInt8], _ value: UInt64) { out.appendLE64(value) }

func appendF64(_ out: inout [UInt8], _ value: Double) { out.appendLE64(value.bitPattern) }

func patchU32(_ out: inout [UInt8], at offset: Int, _ value: UInt32) {
    out.withUnsafeMutableBytes { $0.storeLE32(value, at: offset) }
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

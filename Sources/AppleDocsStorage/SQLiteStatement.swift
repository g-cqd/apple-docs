import CSQLite

/// Safe, non-copyable wrapper around a `sqlite3_stmt` prepared statement.
///
/// Always finalizes its underlying handle in `deinit` and resets/clears bindings
/// before reuse inside ``SQLiteConnection``'s prepared-statement cache.
final class SQLiteStatement {
    private nonisolated(unsafe) var handle: OpaquePointer?

    init(connection: OpaquePointer, sql: String) throws(SQLiteError) {
        var stmt: OpaquePointer?
        let rc = unsafe sqlite3_prepare_v2(connection, sql, -1, &stmt, nil)
        guard rc == SQLITE_OK, let prepared = stmt else {
            throw SQLiteError.fromHandle(connection, code: rc)
        }
        self.handle = prepared
    }

    deinit {
        if let stmt = handle {
            _ = unsafe sqlite3_finalize(stmt)
        }
    }

    /// Resets stepping state and clears parameter bindings for statement reuse.
    func reset() {
        guard let stmt = handle else { return }
        _ = unsafe sqlite3_reset(stmt)
        _ = unsafe sqlite3_clear_bindings(stmt)
    }

    /// Binds positional `1...N` parameter values using `SQLITE_TRANSIENT` for text/blob buffers.
    func bind(_ values: [SQLiteValue]) throws(SQLiteError) {
        guard let stmt = handle else { throw .closed }
        let expected = Int(unsafe sqlite3_bind_parameter_count(stmt))
        guard values.count <= expected else {
            throw .invalidParameterIndex(values.count)
        }
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let rc = bindSingle(value, at: index, on: stmt)
            guard rc == SQLITE_OK else {
                throw SQLiteError.fromHandle(unsafe sqlite3_db_handle(stmt), code: rc)
            }
        }
    }

    /// Binds named parameters (`$name`, `:name`, `@name`; the key includes the prefix). Every parameter the
    /// statement declares must be supplied, so a typo can never silently bind `NULL`.
    func bind(named values: [String: SQLiteValue]) throws(SQLiteError) {
        guard let stmt = handle else { throw .closed }
        let count = unsafe sqlite3_bind_parameter_count(stmt)
        guard count > 0 else { return }
        for index in Int32(1) ... count {
            guard let rawName = unsafe sqlite3_bind_parameter_name(stmt, index) else {
                throw .invalidParameterIndex(Int(index))
            }
            let name = unsafe String(cString: rawName)
            guard let value = values[name] else { throw .missingParameter(name) }
            let rc = bindSingle(value, at: index, on: stmt)
            guard rc == SQLITE_OK else {
                throw SQLiteError.fromHandle(unsafe sqlite3_db_handle(stmt), code: rc)
            }
        }
    }

    /// Executes the statement to completion without returning rows.
    func run() throws(SQLiteError) {
        guard let stmt = handle else { throw .closed }
        defer { reset() }
        while true {
            let rc = unsafe sqlite3_step(stmt)
            if rc == SQLITE_DONE { return }
            if rc == SQLITE_ROW { continue }
            throw SQLiteError.fromHandle(unsafe sqlite3_db_handle(stmt), code: rc)
        }
    }

    /// Steps through every result row and materializes ``SQLiteRow`` values.
    func queryAll() throws(SQLiteError) -> [SQLiteRow] {
        guard let stmt = handle else { throw .closed }
        defer { reset() }
        let columnCount = Int(unsafe sqlite3_column_count(stmt))
        var rows: [SQLiteRow] = []
        while true {
            let rc = unsafe sqlite3_step(stmt)
            if rc == SQLITE_DONE {
                return rows
            }
            if rc == SQLITE_ROW {
                rows.append(readRow(stmt: stmt, columnCount: columnCount))
                continue
            }
            throw SQLiteError.fromHandle(unsafe sqlite3_db_handle(stmt), code: rc)
        }
    }

    private func bindSingle(_ value: SQLiteValue, at index: Int32, on stmt: OpaquePointer) -> Int32 {
        let transient = unsafe unsafeBitCast(Int(-1), to: sqlite3_destructor_type.self)
        switch value {
            case .null:
                return unsafe sqlite3_bind_null(stmt, index)
            case .integer(let number):
                return unsafe sqlite3_bind_int64(stmt, index, number)
            case .real(let number):
                return unsafe sqlite3_bind_double(stmt, index, number)
            case .text(let string):
                let fallback = {
                    string.withCString { cString in
                        unsafe sqlite3_bind_text(stmt, index, cString, -1, transient)
                    }
                }
                return string.utf8.withContiguousStorageIfAvailable { buffer in
                    unsafe sqlite3_bind_text(
                        stmt,
                        index,
                        unsafeBitCast(buffer.baseAddress, to: UnsafePointer<CChar>?.self),
                        Int32(buffer.count),
                        transient
                    )
                } ?? fallback()
            case .blob(let bytes):
                if bytes.isEmpty {
                    return unsafe sqlite3_bind_blob(stmt, index, nil, 0, transient)
                }
                return bytes.withUnsafeBytes { raw in
                    unsafe sqlite3_bind_blob(stmt, index, raw.baseAddress, Int32(raw.count), transient)
                }
        }
    }

    private func readRow(stmt: OpaquePointer, columnCount: Int) -> SQLiteRow {
        var values: [SQLiteValue] = []
        values.reserveCapacity(columnCount)
        for column in 0 ..< columnCount {
            let index = Int32(column)
            switch unsafe sqlite3_column_type(stmt, index) {
                case SQLITE_NULL:
                    values.append(.null)
                case SQLITE_INTEGER:
                    values.append(.integer(unsafe sqlite3_column_int64(stmt, index)))
                case SQLITE_FLOAT:
                    values.append(.real(unsafe sqlite3_column_double(stmt, index)))
                case SQLITE_TEXT:
                    if let pointer = unsafe sqlite3_column_text(stmt, index) {
                        let byteCount = Int(unsafe sqlite3_column_bytes(stmt, index))
                        let buffer = unsafe UnsafeBufferPointer(start: pointer, count: byteCount)
                        values.append(.text(String(decoding: buffer, as: UTF8.self)))
                    } else {
                        values.append(.text(""))
                    }
                case SQLITE_BLOB:
                    let byteCount = Int(unsafe sqlite3_column_bytes(stmt, index))
                    if byteCount > 0, let pointer = unsafe sqlite3_column_blob(stmt, index) {
                        let buffer = unsafe UnsafeRawBufferPointer(start: pointer, count: byteCount)
                        values.append(.blob(Array(buffer)))
                    } else {
                        values.append(.blob([]))
                    }
                default:
                    values.append(.null)
            }
        }
        return SQLiteRow(values: values)
    }
}

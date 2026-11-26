import CSQLite

/// Typed error returned by every `AppleDocsStorage` SQLite operation.
public enum SQLiteError: Error, Hashable, Sendable, CustomStringConvertible {
    /// SQLite C API returned a non-OK result code.
    case sqlite(code: Int32, message: String)
    /// Attempted to operate on a connection or statement after it was closed.
    case closed
    /// Caller requested a column index or type that does not match the result row.
    case typeMismatch(column: Int, expected: String)
    /// Attempted to bind a parameter index out of range (`1...parameterCount`).
    case invalidParameterIndex(Int)
    /// Attempted to read from a legacy or unsupported database schema.
    case unsupportedSchema(found: Int)
    /// Transaction commit or rollback failed while unwinding.
    case transactionFailed(String)

    public var description: String {
        switch self {
            case .sqlite(let code, let message):
                "SQLite error (\(code)): \(message)"
            case .closed:
                "SQLite handle is closed."
            case .typeMismatch(let column, let expected):
                "SQLite column \(column) cannot be read as \(expected)."
            case .invalidParameterIndex(let index):
                "SQLite bind parameter index \(index) is out of range."
            case .unsupportedSchema(let found):
                "Unsupported corpus schema version \(found)."
            case .transactionFailed(let detail):
                "SQLite transaction failed: \(detail)"
        }
    }

    static func fromHandle(_ db: OpaquePointer?, code: Int32) -> Self {
        if let db, let cString = unsafe sqlite3_errmsg(db) {
            return .sqlite(code: code, message: unsafe String(cString: cString))
        }
        if let cString = unsafe sqlite3_errstr(code) {
            return .sqlite(code: code, message: unsafe String(cString: cString))
        }
        return .sqlite(code: code, message: "SQLite error \(code)")
    }
}

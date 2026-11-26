/// Materialized SQLite result row supporting positional typed extraction.
public struct SQLiteRow: Hashable, Sendable {
    public let values: [SQLiteValue]

    public init(values: [SQLiteValue]) {
        self.values = values
    }

    public var count: Int { values.count }

    /// Returns the raw ``SQLiteValue`` at `index`.
    public func value(at index: Int) throws(SQLiteError) -> SQLiteValue {
        guard index >= 0, index < values.count else {
            throw .typeMismatch(column: index, expected: "column")
        }
        return values[index]
    }

    /// Decodes a required typed column value at `index`.
    public func column<T: SQLiteColumnDecodable>(
        at index: Int,
        as type: T.Type = T.self
    ) throws(SQLiteError) -> T {
        let cell = try value(at: index)
        guard let decoded = T.decode(from: cell) else {
            throw .typeMismatch(column: index, expected: T.sqliteTypeName)
        }
        return decoded
    }

    /// Decodes an optional typed column value at `index` (`nil` for SQL `NULL`).
    public func optionalColumn<T: SQLiteColumnDecodable>(
        at index: Int,
        as type: T.Type = T.self
    ) throws(SQLiteError) -> T? {
        let cell = try value(at: index)
        if cell.isNull { return nil }
        guard let decoded = T.decode(from: cell) else {
            throw .typeMismatch(column: index, expected: "\(T.sqliteTypeName)?")
        }
        return decoded
    }

    /// Convenience shortcut for `column(at: index, as: Int64.self)`.
    public func integer(at index: Int) throws(SQLiteError) -> Int64 {
        try column(at: index)
    }

    /// Convenience shortcut for `optionalColumn(at: index, as: Int64.self)`.
    public func optionalInteger(at index: Int) throws(SQLiteError) -> Int64? {
        try optionalColumn(at: index)
    }

    /// Convenience shortcut for `column(at: index, as: String.self)`.
    public func text(at index: Int) throws(SQLiteError) -> String {
        try column(at: index)
    }

    /// Convenience shortcut for `optionalColumn(at: index, as: String.self)`.
    public func optionalText(at index: Int) throws(SQLiteError) -> String? {
        try optionalColumn(at: index)
    }

    /// Convenience shortcut for `optionalColumn(at: index, as: [UInt8].self)`.
    public func optionalBlob(at index: Int) throws(SQLiteError) -> [UInt8]? {
        try optionalColumn(at: index)
    }

    /// Extracts a SQLite integer flag (`0` = `false`, non-zero = `true`) at `index`.
    public func bool(at index: Int) throws(SQLiteError) -> Bool {
        try integer(at: index) != 0
    }
}

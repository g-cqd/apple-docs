/// Type that can be extracted directly from a ``SQLiteValue``.
public protocol SQLiteColumnDecodable {
    /// Human-readable SQLite type name used in ``SQLiteError/typeMismatch(column:expected:)``.
    static var sqliteTypeName: String { get }
    /// Decodes a value from `cell`, returning `nil` when the storage class does not match.
    static func decode(from cell: SQLiteValue) -> Self?
}

extension Int64: SQLiteColumnDecodable {
    public static var sqliteTypeName: String { "INTEGER" }
    public static func decode(from cell: SQLiteValue) -> Int64? { cell.integerValue }
}

extension Double: SQLiteColumnDecodable {
    public static var sqliteTypeName: String { "REAL" }
    public static func decode(from cell: SQLiteValue) -> Double? { cell.realValue }
}

extension String: SQLiteColumnDecodable {
    public static var sqliteTypeName: String { "TEXT" }
    public static func decode(from cell: SQLiteValue) -> String? { cell.textValue }
}

extension [UInt8]: SQLiteColumnDecodable {
    public static var sqliteTypeName: String { "BLOB" }
    public static func decode(from cell: SQLiteValue) -> [UInt8]? { cell.blobValue }
}

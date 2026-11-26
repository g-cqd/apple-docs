/// Strongly typed SQLite column or bound parameter value.
public enum SQLiteValue: Hashable, Sendable {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob([UInt8])

    /// Encodes an optional `String` as `.text` or `.null`.
    public static func optionalText(_ value: String?) -> Self {
        value.map(Self.text) ?? .null
    }

    /// Encodes an optional `Int64` as `.integer` or `.null`.
    public static func optionalInteger(_ value: Int64?) -> Self {
        value.map(Self.integer) ?? .null
    }

    /// Encodes a `Bool` as SQLite integer `1` or `0`.
    public static func flag(_ value: Bool) -> Self {
        .integer(value ? 1 : 0)
    }

    public var integerValue: Int64? {
        if case .integer(let value) = self { return value }
        return nil
    }

    public var realValue: Double? {
        if case .real(let value) = self { return value }
        return nil
    }

    public var textValue: String? {
        if case .text(let value) = self { return value }
        return nil
    }

    public var blobValue: [UInt8]? {
        if case .blob(let value) = self { return value }
        return nil
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }
}

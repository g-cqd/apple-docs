/// Strongly typed SQLite column or bound parameter value.
public enum SQLiteValue: Hashable, Sendable {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob([UInt8])

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

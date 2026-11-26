public import AemiJSONCore

/// Small ``JSONValue`` constructors shared by the Bun-compatible command ports.
public enum DocCValue {
    /// A string, or `null` when absent.
    public static func optional(_ value: String?) -> JSONValue {
        value.map(JSONValue.string) ?? .null
    }
}

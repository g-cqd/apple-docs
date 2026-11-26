import AemiJSONCore
import OrderedCollections

/// The member storage of a ``JSONValue/object(_:)``.
typealias OrderedJSONObject = OrderedDictionary<String, JSONValue>

extension JSONValue {
    /// The string payload, if this is a string.
    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    /// JavaScript truthiness (`null`, `false`, `0`, `""` are falsy; containers are truthy).
    var isTruthy: Bool {
        switch self {
            case .null: false
            case .bool(let value): value
            case .int(let value): value != 0
            case .number(let value): value != 0 && !value.isNaN
            case .string(let value): !value.isEmpty
            case .array, .object: true
        }
    }

    /// Compact UTF-8 JSON text (`JSON.stringify` equivalent for storage).
    var jsonText: String {
        (try? encodedBytes()).map { String(decoding: $0, as: UTF8.self) } ?? "null"
    }
}

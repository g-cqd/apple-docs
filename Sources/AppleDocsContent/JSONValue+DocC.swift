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

    /// Compact UTF-8 JSON text (`JSON.stringify` equivalent for storage).
    var jsonText: String {
        (try? encodedBytes()).map { String(decoding: $0, as: UTF8.self) } ?? "null"
    }
}

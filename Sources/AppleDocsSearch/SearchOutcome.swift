public import AemiJSONCore
import OrderedCollections

/// A search's results and metadata (Bun's `search()` return value).
public struct SearchOutcome: Sendable {
    public var results: [SearchResultItem]
    public var total: Int
    public var hasMore: Bool
    public var query: String
    public var intent: SearchIntent?
    public var relaxationTier: String?
    public var tier: String?
    public var trigramAvailable: Bool
    public var bodyIndexAvailable: Bool

    /// The envelope as Bun serializes it (what MCP pagination budgets against).
    public var jsonValue: JSONValue {
        var object: OrderedDictionary<String, JSONValue> = [
            "results": .array(results.map(\.jsonValue)),
            "total": .int(Int64(total))
        ]
        guard let intent else {
            object["query"] = .string(query)
            return .object(object)
        }
        object["hasMore"] = .bool(hasMore)
        object["query"] = .string(query)
        object["intent"] = .object(["type": .string(intent.kind.rawValue), "confidence": .number(intent.confidence)])
        if let relaxationTier {
            object["relaxed"] = .bool(true)
            object["relaxationTier"] = .string(relaxationTier)
        }
        object["tier"] = tier.map(JSONValue.string) ?? .null
        object["trigramAvailable"] = .bool(trigramAvailable)
        object["bodyIndexAvailable"] = .bool(bodyIndexAvailable)
        return .object(object)
    }
}

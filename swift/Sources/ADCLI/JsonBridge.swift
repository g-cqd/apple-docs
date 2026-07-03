// Verb-output JSON, owned by g-cqd/ADJSON. The projections build an ordered
// `JSONValue` tree (ADJSONCore) and serialize through the `.javaScript(space: 2)`
// profile — byte-for-byte `JSON.stringify(value, null, 2)`: `": "` key separators,
// 2-space indent, ECMA-262 numbers (`13.0` → `13`, `-0` → `0`), lowercase `\uXXXX`
// control escapes, `/` left unescaped. The reparse of a `platforms_json` column
// goes through `JSONValue(parsing:)`. This replaces the hand-rolled `J` model, the
// `stringifyPretty` serializer, and the UTF-16 `parseJSONValue` parser that
// duplicated ADJSON's tested codec.

import ADJSONCore
import OrderedCollections

extension JSONValue {
    /// An ordered JSON object built from declared key/value pairs — the projection
    /// builder for the verb outputs. Insertion order is preserved (it pins the
    /// byte-parity key order) and a duplicate key takes the last value, matching
    /// ADJSON's own `makeObject` / dictionary-literal `.useLast` policy.
    static func obj(_ members: [(String, JSONValue)]) -> JSONValue {
        var object = OrderedDictionary<String, JSONValue>(minimumCapacity: members.count)
        for (key, value) in members { object[key] = value }
        return .object(object)
    }
}

/// `JSON.stringify(value, null, 2)` byte-for-byte via ADJSON's encoder. The
/// `.javaScript(space: 2)` profile maps non-finite numbers to `null` and the
/// verb projections nest only a few levels, so the encode is total — it cannot
/// throw the depth-limit or non-finite errors `encodedBytes` reserves.
func stringifyPretty(_ value: JSONValue) -> String {
    // Total for these projections (non-finite → null, shallow nesting), so the encode never actually
    // throws; fall back to `null` rather than trapping if that invariant ever drifts.
    guard let bytes = try? value.encodedBytes(options: .javaScript(space: 2)) else { return "null" }
    return String(decoding: bytes, as: UTF8.self)
}

/// Parse a complete JSON document into a `JSONValue`, or nil on malformed / trailing
/// input — the `platforms_json` and activity-roots reparse paths, whose callers fall
/// back to `[]` / nil exactly as the JS `JSON.parse` throw path does.
func parseJSONValue(_ text: String) -> JSONValue? {
    try? JSONValue(parsing: text)
}

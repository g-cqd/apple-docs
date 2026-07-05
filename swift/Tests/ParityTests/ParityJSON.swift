// Intrinsic JSON comparison for the parity harness (RFC 0007 §3/§12: "JSON output is compared
// intrinsically (deep-equal parsed) via ADJSON"). Parses both engines' stdout as `JSONValue`,
// redacts any field at a documented "volatile" dotted path (an absolute fixture path, a
// storage-engine-specific byte count, ...), and compares what's left via `JSONValue`'s own `==` —
// which already compares object members unordered (JSON key order is never semantically
// meaningful) while keeping arrays order-sensitive (e.g. search-result ranking IS meaningful).

import ADJSONCore
import OrderedCollections

enum ParityJSON {
    struct Comparison: Sendable {
        var isMatch: Bool
        /// A human-readable explanation: "intrinsic match" on success, or a rendering of both
        /// (redacted) trees on failure.
        var detail: String
    }

    /// Parses `lhsText`/`rhsText`, drops every key at a path in `excludedPaths` from BOTH sides
    /// (a dotted path like `"freshness.daysSinceSync"`; matches at any array depth, see
    /// `JSONValue.redacting`), and compares the remainder. A parse failure on either side is
    /// reported as a mismatch carrying the raw text — a parity case whose output isn't even valid
    /// JSON is itself the finding, not a harness crash.
    static func compare(
        lhsLabel: String, lhsText: String, rhsLabel: String, rhsText: String,
        excludedPaths: Set<String> = []
    ) -> Comparison {
        guard let lhsValue = try? JSONValue(parsing: lhsText) else {
            return Comparison(isMatch: false, detail: "\(lhsLabel) did not parse as JSON:\n\(lhsText)")
        }
        guard let rhsValue = try? JSONValue(parsing: rhsText) else {
            return Comparison(isMatch: false, detail: "\(rhsLabel) did not parse as JSON:\n\(rhsText)")
        }
        let lhsRedacted = lhsValue.redacting(paths: excludedPaths)
        let rhsRedacted = rhsValue.redacting(paths: excludedPaths)
        if lhsRedacted == rhsRedacted {
            return Comparison(isMatch: true, detail: "intrinsic JSON match")
        }
        let excludedNote =
            excludedPaths.isEmpty ? "" : " (after excluding \(excludedPaths.sorted()))"
        return Comparison(
            isMatch: false,
            detail: """
                JSON mismatch\(excludedNote):
                  \(lhsLabel): \(prettyPrint(lhsRedacted))
                  \(rhsLabel): \(prettyPrint(rhsRedacted))
                """)
    }

    /// `JSON.stringify(value, null, 2)`-shaped rendering for a diagnostic message. Declaration-order
    /// (not sorted) so the printed tree still reads like the original envelope.
    static func prettyPrint(_ value: JSONValue) -> String {
        guard let bytes = try? value.encodedBytes(options: .javaScript(space: 2)) else { return "<unencodable>" }
        return String(decoding: bytes, as: UTF8.self)
    }
}

extension JSONValue {
    /// Returns a copy of `self` with every object member whose dotted key path is in `paths`
    /// removed. Recurses into both objects (extending the path with `.key`) and arrays (reusing the
    /// same path for every element — a path names a LOGICAL field location, not a positional one),
    /// so an excluded path matches wherever it occurs, at any nesting depth under an array.
    func redacting(paths: Set<String>) -> JSONValue {
        guard !paths.isEmpty else { return self }
        return redacting(paths: paths, prefix: "")
    }

    private func redacting(paths: Set<String>, prefix: String) -> JSONValue {
        switch self {
            case .object(let members):
                var result = OrderedDictionary<String, JSONValue>()
                for (key, value) in members {
                    let path = prefix.isEmpty ? key : "\(prefix).\(key)"
                    if paths.contains(path) { continue }
                    result[key] = value.redacting(paths: paths, prefix: path)
                }
                return .object(result)
            case .array(let elements):
                return .array(elements.map { $0.redacting(paths: paths, prefix: prefix) })
            case .null, .bool, .int, .number, .string:
                return self
        }
    }
}

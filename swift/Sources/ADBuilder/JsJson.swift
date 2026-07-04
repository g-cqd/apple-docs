// JsJson — a minimal insertion-ordered JSON text builder with `JSON.stringify`
// string escaping, for the content_json / source_metadata payloads adapters
// persist. The JS writer emits JSON.stringify bytes into the corpus, so
// cross-writer crawl parity needs the SAME key order (insertion, not sorted)
// and the same escape set. (JSONSerialization's .sortedKeys reorders — fine
// for opaque metadata, wrong for byte-compared payloads.)

public indirect enum JsJson: Sendable {
    case string(String)
    case int(Int)
    case bool(Bool)
    case null
    case object([(String, JsJson)])
    case array([JsJson])

    /// Compact serialization, byte-identical to `JSON.stringify(value)` for
    /// this value domain (strings/ints/bools/null/containers).
    public func serialized() -> String {
        switch self {
            case .string(let s): return "\"\(Self.escape(s))\""
            case .int(let i): return String(i)
            case .bool(let b): return b ? "true" : "false"
            case .null: return "null"
            case .object(let pairs):
                return "{"
                    + pairs.map { "\"\(Self.escape($0.0))\":\($0.1.serialized())" }.joined(separator: ",")
                    + "}"
            case .array(let items):
                return "[" + items.map { $0.serialized() }.joined(separator: ",") + "]"
        }
    }

    /// The `JSON.stringify` string escape (quote, backslash, control chars;
    /// non-ASCII verbatim; `/` untouched).
    public static func escape(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count + 2)
        for scalar in s.unicodeScalars {
            switch scalar {
                case "\"": out += "\\\""
                case "\\": out += "\\\\"
                case "\u{08}": out += "\\b"
                case "\u{0C}": out += "\\f"
                case "\n": out += "\\n"
                case "\r": out += "\\r"
                case "\t": out += "\\t"
                default:
                    if scalar.value < 0x20 {
                        let hex = String(scalar.value, radix: 16)
                        out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                    } else {
                        out.unicodeScalars.append(scalar)
                    }
            }
        }
        return out
    }
}

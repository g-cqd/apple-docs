// A tiny ordered JSON value + compact serializer matching `JSON.stringify`
// (no spaces, insertion-ordered keys), for the page JSON-LD blobs. The result
// is then `<>&`-escaped via `PageShell.escapeJsonLd` before embedding.

indirect enum JsonLd: Sendable {
    case string(String)
    case bool(Bool)
    case int(Int)
    case null
    case object([(String, JsonLd)])
    case array([JsonLd])

    /// Compact serialization, byte-identical to `JSON.stringify(value)`.
    func serialized() -> String {
        switch self {
        case .string(let s): return "\"\(Self.escapeString(s))\""
        case .bool(let b): return b ? "true" : "false"
        case .int(let i): return String(i)
        case .null: return "null"
        case .object(let pairs):
            return "{" + pairs.map { "\"\(Self.escapeString($0.0))\":\($0.1.serialized())" }.joined(separator: ",") + "}"
        case .array(let items):
            return "[" + items.map { $0.serialized() }.joined(separator: ",") + "]"
        }
    }

    /// Pretty serialization, byte-identical to `JSON.stringify(value, null, space)`:
    /// `": "` key separator, each nesting level indented by `space` spaces, empty
    /// objects/arrays compact (`{}` / `[]`).
    func serializedPretty(_ space: Int = 2, level: Int = 0) -> String {
        let pad = String(repeating: " ", count: space * (level + 1))
        let closePad = String(repeating: " ", count: space * level)
        switch self {
        case .object(let pairs):
            if pairs.isEmpty { return "{}" }
            let body = pairs.map {
                "\(pad)\"\(Self.escapeString($0.0))\": \($0.1.serializedPretty(space, level: level + 1))"
            }.joined(separator: ",\n")
            return "{\n\(body)\n\(closePad)}"
        case .array(let items):
            if items.isEmpty { return "[]" }
            let body = items.map { "\(pad)\($0.serializedPretty(space, level: level + 1))" }
                .joined(separator: ",\n")
            return "[\n\(body)\n\(closePad)]"
        default:
            return serialized()
        }
    }

    /// The `JSON.stringify` string-escape (does NOT touch `< > &` — that's
    /// `escapeJsonLd`'s job — and leaves non-ASCII verbatim).
    static func escapeString(_ s: String) -> String {
        let hex = Array("0123456789abcdef")
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
                    out += "\\u00"
                    out.append(hex[Int(scalar.value >> 4) & 0xF])
                    out.append(hex[Int(scalar.value) & 0xF])
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out
    }
}

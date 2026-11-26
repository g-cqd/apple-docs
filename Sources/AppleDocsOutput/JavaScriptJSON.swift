public import AemiJSONCore
import OrderedCollections

/// `JSON.stringify` semantics for ``JSONValue`` — the exact compact text Bun puts in MCP tool results, and the
/// length (UTF-16 code units, like a JavaScript string's `length`) its paginator budgets against.
public enum JavaScriptJSON {
    /// Compact JSON text identical to JavaScript's `JSON.stringify(value)`.
    public static func stringify(_ value: JSONValue) -> String {
        var out = ""
        append(value, to: &out)
        return out
    }

    /// `JSON.stringify(value).length`, counted without building the text (the paginator probes this often).
    public static func length(_ value: JSONValue) -> Int {
        switch value {
            case .null: 4
            case .bool(let flag): flag ? 4 : 5
            case .int(let number): String(number).utf8.count
            case .number(let number): format(number).utf8.count
            case .string(let text): quotedLength(text)
            case .array(let items): items.reduce(max(1, items.count) + 1) { $0 + length($1) }
            case .object(let members):
                members.reduce(max(1, members.count) + 1) { $0 + quotedLength($1.key) + 1 + length($1.value) }
        }
    }

    /// Length of `text` as a JSON string literal, in UTF-16 code units.
    private static func quotedLength(_ text: String) -> Int {
        var count = 2
        for unit in text.utf16 {
            switch unit {
                case 0x22, 0x5C, 0x08, 0x09, 0x0A, 0x0C, 0x0D: count += 2
                case 0x00 ..< 0x20: count += 6
                default: count += 1
            }
        }
        return count
    }

    private static func append(_ value: JSONValue, to out: inout String) {
        switch value {
            case .null: out += "null"
            case .bool(let flag): out += flag ? "true" : "false"
            case .int(let number): out += String(number)
            case .number(let number): out += format(number)
            case .string(let text): appendString(text, to: &out)
            case .array(let items):
                out += "["
                for (index, item) in items.enumerated() {
                    if index > 0 { out += "," }
                    append(item, to: &out)
                }
                out += "]"
            case .object(let members):
                out += "{"
                for (index, member) in members.enumerated() {
                    if index > 0 { out += "," }
                    appendString(member.key, to: &out)
                    out += ":"
                    append(member.value, to: &out)
                }
                out += "}"
        }
    }

    /// JavaScript `Number#toString` for the values Bun payloads carry (integers, short decimals).
    private static func format(_ number: Double) -> String {
        guard number.isFinite else { return "null" }
        if number == number.rounded(), abs(number) < 1e21 { return String(Int64(number)) }
        let text = String(number)
        guard let exponent = text.firstIndex(of: "e") else { return text }
        let mantissa = String(text[..<exponent])
        let power = Int(text[text.index(after: exponent)...].replacing("+", with: "")) ?? 0
        if power < 0, power >= -6 {  // JavaScript keeps plain decimals down to 1e-6.
            let negative = mantissa.hasPrefix("-")
            let digits = mantissa.replacing("-", with: "").replacing(".", with: "")
            return (negative ? "-" : "") + "0." + String(repeating: "0", count: -power - 1) + digits
        }
        return "\(mantissa)e\(power < 0 ? "-" : "+")\(abs(power))"
    }

    private static func appendString(_ text: String, to out: inout String) {
        out += "\""
        for scalar in text.unicodeScalars {
            switch scalar {
                case "\"": out += "\\\""
                case "\\": out += "\\\\"
                case "\n": out += "\\n"
                case "\r": out += "\\r"
                case "\t": out += "\\t"
                case "\u{08}": out += "\\b"
                case "\u{0C}": out += "\\f"
                default:
                    if scalar.value < 0x20 {
                        let hex = String(scalar.value, radix: 16)
                        out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                    } else {
                        out.unicodeScalars.append(scalar)
                    }
            }
        }
        out += "\""
    }
}

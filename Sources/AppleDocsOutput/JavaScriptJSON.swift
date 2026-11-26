public import AemiJSONCore

/// `JSON.stringify` semantics for ``JSONValue`` — the exact compact text Bun puts in MCP tool results, and the
/// length (UTF-16 code units, like a JavaScript string's `length`) its paginator budgets against.
public enum JavaScriptJSON {
    /// Compact JSON text identical to JavaScript's `JSON.stringify(value)`.
    public static func stringify(_ value: JSONValue) -> String {
        var out = ""
        append(value, to: &out)
        return out
    }

    /// `JSON.stringify(value).length`.
    public static func length(_ value: JSONValue) -> Int {
        stringify(value).utf16.count
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

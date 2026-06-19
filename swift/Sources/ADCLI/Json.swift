// A tiny, ordered JSON model + a serializer that matches Node/Bun
// `JSON.stringify(value, null, 2)` BYTE-FOR-BYTE: 2-space indent, `": "` key
// separator (one space after the colon, none before — unlike Foundation's
// `" : "`), JSON string escaping, bare integers. The `--json` branch projects
// the read result into `J`, then prints `stringifyPretty(value)`.

/// An ordered JSON value. `obj` preserves declared key order (the projection
/// pins it), which matters for byte parity with the JS object-literal order.
/// `null`/`bool` exist because `pick` copies JSON `null` values through (a nil
/// optional field is emitted as `null`, not omitted) and the read/search verbs
/// carry boolean fields (e.g. `limited`).
enum J {
    case s(String)
    case i(Int64)
    /// A JSON number parsed from input (e.g. a `platforms_json` value) that must
    /// round-trip through `JSON.parse`→`JSON.stringify`. Serialized via the
    /// JS-aligned formatter in `stringifyPretty` (integers bare; the `.0` of an
    /// integral double dropped, matching JS). `.i` stays the canonical integer
    /// constructor for counts/totals.
    case num(Double)
    case bool(Bool)
    case null
    case arr([J])
    case obj([(String, J)])
}

/// Serializes `v` identically to `JSON.stringify(v, null, 2)`.
func stringifyPretty(_ v: J, _ level: Int = 0) -> String {
    switch v {
    case let .s(string):
        return encodeJSONString(string)
    case let .i(int):
        return String(int)
    case let .num(number):
        return formatJSONNumber(number)
    case let .bool(flag):
        return flag ? "true" : "false"
    case .null:
        return "null"
    case let .arr(items):
        if items.isEmpty { return "[]" }
        let inner = String(repeating: " ", count: (level + 1) * 2)
        let outer = String(repeating: " ", count: level * 2)
        let body = items.map { inner + stringifyPretty($0, level + 1) }.joined(separator: ",\n")
        return "[\n" + body + "\n" + outer + "]"
    case let .obj(pairs):
        if pairs.isEmpty { return "{}" }
        let inner = String(repeating: " ", count: (level + 1) * 2)
        let outer = String(repeating: " ", count: level * 2)
        let body = pairs.map { key, value in
            inner + encodeJSONString(key) + ": " + stringifyPretty(value, level + 1)
        }.joined(separator: ",\n")
        return "{\n" + body + "\n" + outer + "}"
    }
}

/// JSON string literal with the canonical escapes (matches `JSON.stringify`):
/// `"` `\` get backslash escapes; U+0008/U+0009/U+000A/U+000C/U+000D use their
/// short forms; any other control char < U+0020 is `\uXXXX` (lowercase hex).
/// `/` is NOT escaped.
private func encodeJSONString(_ string: String) -> String {
    var out = "\""
    out.reserveCapacity(string.utf8.count + 2)
    for scalar in string.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\u{08}": out += "\\b"
        case "\u{09}": out += "\\t"
        case "\u{0A}": out += "\\n"
        case "\u{0C}": out += "\\f"
        case "\u{0D}": out += "\\r"
        case let s where s.value < 0x20:
            out += "\\u"
            out += String(format4Hex(s.value))
        default:
            out.unicodeScalars.append(scalar)
        }
    }
    out += "\""
    return out
}

/// Serialize a parsed JSON number the way `JSON.stringify` does: an integral
/// value (within Int64 range) prints with no decimal point (`13.0` → `13`), so a
/// `JSON.parse("13.0")`→stringify round-trip matches. Non-integral finite values
/// use Swift's shortest round-trippable `Double` description, which coincides with
/// JS for ordinary decimals (no JSON number in the corpus's platforms exercises
/// this branch). NaN/Infinity can't appear in valid JSON input.
private func formatJSONNumber(_ value: Double) -> String {
    if value.rounded(.towardZero) == value, value.isFinite,
        value >= -9.223_372_036_854_775_8e18, value < 9.223_372_036_854_775_8e18
    {
        return String(Int64(value))
    }
    return String(value)
}

/// Four lowercase hex digits, zero-padded (Foundation-free).
private func format4Hex(_ value: UInt32) -> String {
    let digits = Array("0123456789abcdef")
    var result = ""
    for shift in stride(from: 12, through: 0, by: -4) {
        result.append(digits[Int((value >> UInt32(shift)) & 0xF)])
    }
    return result
}

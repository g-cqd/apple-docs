// A tiny, dependency-free JSON parser producing the ordered `J` model — used to
// reparse a `platforms_json` column value so the `read` verb can re-emit it
// through `stringifyPretty` (matching cli.js's `JSON.parse(page.platforms)` →
// `JSON.stringify`). Object key order is preserved (insertion order, as JS keeps
// it for string keys). Strict JSON grammar: objects, arrays, strings (with the
// standard escapes incl. `\uXXXX` + surrogate pairs), numbers (→ `.num`), and
// the literals true/false/null. Returns nil on any malformed input, so the
// caller falls back to `[]` exactly like JS would on a parse throw.
//
// Scope: this backs the metadata `platforms` field only. On the parity corpus
// every `platforms_json` is a `{string:string}` object, so this is robustness
// for the path-resolution flip rather than a harness-exercised path.

/// Parse a complete JSON document into `J`, or nil if it is malformed / has
/// trailing non-whitespace. UTF-16 code units back the scanner so escapes and
/// surrogate pairs decode the same way JS does.
func parseJSONValue(_ text: String) -> J? {
    var parser = JSONParser(units: Array(text.utf16))
    parser.skipWhitespace()
    guard let value = parser.parseValue() else { return nil }
    parser.skipWhitespace()
    guard parser.isAtEnd else { return nil }
    return value
}

private struct JSONParser {
    let units: [UInt16]
    var index = 0

    var isAtEnd: Bool { index >= units.count }

    mutating func skipWhitespace() {
        // JSON insignificant whitespace: space, tab, LF, CR.
        while index < units.count {
            switch units[index] {
            case 0x20, 0x09, 0x0A, 0x0D: index += 1
            default: return
            }
        }
    }

    private func peek() -> UInt16? { index < units.count ? units[index] : nil }

    mutating func parseValue() -> J? {
        guard let c = peek() else { return nil }
        switch c {
        case 0x7B: return parseObject()  // {
        case 0x5B: return parseArray()  // [
        case 0x22: return parseString().map(J.s)  // "
        case 0x74: return parseLiteral("true", value: .bool(true))  // t
        case 0x66: return parseLiteral("false", value: .bool(false))  // f
        case 0x6E: return parseLiteral("null", value: .null)  // n
        case 0x2D, 0x30...0x39: return parseNumber()  // - or 0-9
        default: return nil
        }
    }

    private mutating func parseLiteral(_ literal: String, value: J) -> J? {
        for expected in literal.utf16 {
            guard index < units.count, units[index] == expected else { return nil }
            index += 1
        }
        return value
    }

    private mutating func parseObject() -> J? {
        index += 1  // consume {
        var pairs: [(String, J)] = []
        skipWhitespace()
        if peek() == 0x7D { index += 1; return .obj(pairs) }  // empty {}
        while true {
            skipWhitespace()
            guard peek() == 0x22, let key = parseString() else { return nil }
            skipWhitespace()
            guard peek() == 0x3A else { return nil }  // :
            index += 1
            skipWhitespace()
            guard let value = parseValue() else { return nil }
            pairs.append((key, value))
            skipWhitespace()
            switch peek() {
            case 0x2C: index += 1  // , → next pair
            case 0x7D: index += 1; return .obj(pairs)  // }
            default: return nil
            }
        }
    }

    private mutating func parseArray() -> J? {
        index += 1  // consume [
        var items: [J] = []
        skipWhitespace()
        if peek() == 0x5D { index += 1; return .arr(items) }  // empty []
        while true {
            skipWhitespace()
            guard let value = parseValue() else { return nil }
            items.append(value)
            skipWhitespace()
            switch peek() {
            case 0x2C: index += 1  // , → next item
            case 0x5D: index += 1; return .arr(items)  // ]
            default: return nil
            }
        }
    }

    private mutating func parseString() -> String? {
        index += 1  // consume opening "
        var scalars = String.UnicodeScalarView()
        while index < units.count {
            let c = units[index]
            index += 1
            switch c {
            case 0x22:  // closing "
                var result = ""
                result.unicodeScalars.append(contentsOf: scalars)
                return result
            case 0x5C:  // backslash escape
                guard index < units.count else { return nil }
                let esc = units[index]
                index += 1
                switch esc {
                case 0x22: scalars.append("\"")
                case 0x5C: scalars.append("\\")
                case 0x2F: scalars.append("/")
                case 0x62: scalars.append("\u{08}")
                case 0x66: scalars.append("\u{0C}")
                case 0x6E: scalars.append("\n")
                case 0x72: scalars.append("\r")
                case 0x74: scalars.append("\t")
                case 0x75:  // \uXXXX (with surrogate-pair handling)
                    guard let unit = readHex4() else { return nil }
                    if unit >= 0xD800, unit <= 0xDBFF {
                        // High surrogate — expect a following \uXXXX low surrogate.
                        guard index + 1 < units.count, units[index] == 0x5C, units[index + 1] == 0x75 else {
                            return nil
                        }
                        index += 2
                        guard let low = readHex4(), low >= 0xDC00, low <= 0xDFFF else { return nil }
                        let codepoint = 0x10000 + (UInt32(unit - 0xD800) << 10) + UInt32(low - 0xDC00)
                        guard let scalar = Unicode.Scalar(codepoint) else { return nil }
                        scalars.append(scalar)
                    } else if unit >= 0xDC00, unit <= 0xDFFF {
                        return nil  // lone low surrogate
                    } else {
                        guard let scalar = Unicode.Scalar(unit) else { return nil }
                        scalars.append(scalar)
                    }
                default: return nil
                }
            default:
                // A raw UTF-16 unit. Surrogate pairs in the source are two
                // consecutive units; decode them together for a valid scalar.
                if c >= 0xD800, c <= 0xDBFF {
                    guard index < units.count else { return nil }
                    let low = units[index]
                    guard low >= 0xDC00, low <= 0xDFFF else { return nil }
                    index += 1
                    let codepoint = 0x10000 + (UInt32(c - 0xD800) << 10) + UInt32(low - 0xDC00)
                    guard let scalar = Unicode.Scalar(codepoint) else { return nil }
                    scalars.append(scalar)
                } else if c >= 0xDC00, c <= 0xDFFF {
                    return nil  // lone low surrogate
                } else if let scalar = Unicode.Scalar(c) {
                    scalars.append(scalar)
                } else {
                    return nil
                }
            }
        }
        return nil  // unterminated string
    }

    /// Read exactly four hex digits → a UInt16 code unit, or nil.
    private mutating func readHex4() -> UInt16? {
        guard index + 4 <= units.count else { return nil }
        var value: UInt16 = 0
        for _ in 0..<4 {
            let c = units[index]
            index += 1
            let digit: UInt16
            switch c {
            case 0x30...0x39: digit = c - 0x30
            case 0x41...0x46: digit = c - 0x41 + 10
            case 0x61...0x66: digit = c - 0x61 + 10
            default: return nil
            }
            value = value << 4 | digit
        }
        return value
    }

    private mutating func parseNumber() -> J? {
        let start = index
        if peek() == 0x2D { index += 1 }  // optional -
        // int
        guard let first = peek() else { return nil }
        if first == 0x30 {
            index += 1  // a leading 0 cannot be followed by more digits
        } else if first >= 0x31, first <= 0x39 {
            while let d = peek(), d >= 0x30, d <= 0x39 { index += 1 }
        } else {
            return nil
        }
        // frac
        if peek() == 0x2E {
            index += 1
            guard let d = peek(), d >= 0x30, d <= 0x39 else { return nil }
            while let d = peek(), d >= 0x30, d <= 0x39 { index += 1 }
        }
        // exp
        if let e = peek(), e == 0x65 || e == 0x45 {
            index += 1
            if let sign = peek(), sign == 0x2B || sign == 0x2D { index += 1 }
            guard let d = peek(), d >= 0x30, d <= 0x39 else { return nil }
            while let d = peek(), d >= 0x30, d <= 0x39 { index += 1 }
        }
        let literal = String(decoding: units[start..<index], as: UTF16.self)
        guard let number = Double(literal) else { return nil }
        return .num(number)
    }
}

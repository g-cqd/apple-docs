/// ASCII-regex helpers matching JavaScript's non-Unicode `\w` / `\b` semantics (Bun's search regexes have no `u` flag).
enum ASCIIWords {
    static func isWord(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
            case 0x30 ... 0x39, 0x41 ... 0x5A, 0x61 ... 0x7A, 0x5F: true
            default: false
        }
    }

    static func isUpper(_ scalar: Unicode.Scalar) -> Bool { (0x41 ... 0x5A).contains(scalar.value) }
    static func isLower(_ scalar: Unicode.Scalar) -> Bool { (0x61 ... 0x7A).contains(scalar.value) }
    static func isLetter(_ scalar: Unicode.Scalar) -> Bool { isUpper(scalar) || isLower(scalar) }

    /// Maximal `\w+` runs, each flagged when the gap before it is non-empty and all whitespace (`\s+`).
    static func runs(_ text: String) -> [(word: String, whitespaceBefore: Bool)] {
        var out: [(String, Bool)] = []
        var current = ""
        var gapLength = 0
        var gapAllWhitespace = true
        for scalar in text.unicodeScalars {
            if isWord(scalar) {
                if current.isEmpty {
                    out.append(("", gapLength > 0 && gapAllWhitespace))
                }
                current.unicodeScalars.append(scalar)
            } else {
                if !current.isEmpty {
                    out[out.count - 1].0 = current
                    current = ""
                    gapLength = 0
                    gapAllWhitespace = true
                }
                gapLength += 1
                if !JSWhitespace.contains(scalar) { gapAllWhitespace = false }
            }
        }
        if !current.isEmpty { out[out.count - 1].0 = current }
        return out.map { (word: $0.0, whitespaceBefore: $0.1) }
    }

    /// `/[a-z][A-Z]/.test(text)`.
    static func hasCamelHump(_ text: String) -> Bool {
        var previousLower = false
        for scalar in text.unicodeScalars {
            if previousLower, isUpper(scalar) { return true }
            previousLower = isLower(scalar)
        }
        return false
    }
}

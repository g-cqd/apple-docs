// Byte-scan helpers for the SF-Symbol PDF→SVG converter (the `SymbolPdfToSvg`
// family). These mirror the JS regex/string ops the converter leans on and are
// shared by BOTH parsers (`PdfObjects` and `ContentStream`).
//
// They live in their own `enum PdfScan` namespace (rather than as module-scope
// free functions) precisely because the names are generic — `isDigit`,
// `matches`, `indexOf` would collide if widened to `internal` at file scope.
// `PdfScan` is `internal`, so call sites in the sibling files resolve through it
// (`PdfScan.isDigit(_:)`), while cross-references *between* helpers stay bare
// (same-type static dispatch). Behaviour is byte-for-byte the prior free
// functions — only the namespace changed.

import Foundation

// MARK: - Byte-scan helpers (mirror the JS regex/string ops)

enum PdfScan {
    /// `[0-9]` (JS `\d`).
    static func isDigit(_ b: UInt8) -> Bool { b >= 0x30 && b <= 0x39 }

    /// JS `\s` restricted to the bytes reachable in a latin-1 view: \t \n \v \f \r
    /// space, plus NBSP (0xA0). Every place the JS converter writes `\s` / `[\s…]`
    /// uses this set (the PDF header regex, skipWs, name/token delimiters).
    static func isPdfWhitespace(_ b: UInt8) -> Bool {
        switch b {
            case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0: return true
            default: return false
        }
    }

    /// JS name/token delimiter class `/[\s/<>[\]]/`.
    static func isNameDelimiter(_ b: UInt8) -> Bool {
        if isPdfWhitespace(b) { return true }
        switch b {
            case 0x2F, 0x3C, 0x3E, 0x5B, 0x5D: return true  // / < > [ ]
            default: return false
        }
    }

    /// `\w` = `[A-Za-z0-9_]`; a `\b` after an `obj` token means the next byte is
    /// NOT a word char (or we're at end-of-input).
    static func isWordChar(_ b: UInt8) -> Bool {
        (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || isDigit(b) || b == 0x5F
    }
    static func isWordBoundaryAfter(_ bytes: [UInt8], _ index: Int) -> Bool {
        index >= bytes.count || !isWordChar(bytes[index])
    }

    /// The next index ≥ from that begins a digit run.
    static func nextDigitStart(_ bytes: [UInt8], from: Int) -> Int? {
        var i = max(0, from)
        while i < bytes.count {
            if isDigit(bytes[i]) { return i }
            i += 1
        }
        return nil
    }

    /// `text.startsWith(needle, at)` for a byte needle.
    static func matches(_ bytes: [UInt8], at index: Int, _ needle: [UInt8]) -> Bool {
        guard index >= 0, index + needle.count <= bytes.count else { return false }
        for k in 0 ..< needle.count where bytes[index + k] != needle[k] { return false }
        return true
    }
    static func matches(_ bytes: [UInt8], at index: Int, _ needle: String) -> Bool {
        matches(bytes, at: index, Array(needle.utf8))
    }

    /// `text.indexOf(needle, from)` (optionally bounded by `upTo`, exclusive),
    /// returning the absolute index or nil.
    static func indexOf(_ bytes: [UInt8], _ needle: String, from: Int, upTo: Int? = nil) -> Int? {
        let needleBytes = Array(needle.utf8)
        if needleBytes.isEmpty { return from }
        let limit = (upTo ?? bytes.count) - needleBytes.count
        var i = max(0, from)
        while i <= limit {
            if matches(bytes, at: i, needleBytes) { return i }
            i += 1
        }
        return nil
    }

    /// `String.fromCharCode` over an ASCII byte range — these slices are object ids
    /// / dict keys / numeric tokens (all ASCII in CGContext PDFs).
    static func asciiString(_ bytes: [UInt8], _ start: Int, _ end: Int) -> String {
        guard start < end, start >= 0, end <= bytes.count else { return "" }
        return String(decoding: bytes[start ..< end], as: UTF8.self)
    }

    /// `skipWs(text, i)` — advance over JS `\s`.
    static func skipWs(_ bytes: [UInt8], _ start: Int, _ end: Int) -> Int {
        var i = start
        while i < end, isPdfWhitespace(bytes[i]) { i += 1 }
        return i
    }

    /// `findMatching(text, start, open, close)` — balanced `<<`/`>>` matching; the
    /// JS fallback when unbalanced is `text.length - close.length`.
    static func findMatching(_ bytes: [UInt8], _ start: Int, _ end: Int, open: String, close: String) -> Int {
        let openBytes = Array(open.utf8)
        let closeBytes = Array(close.utf8)
        var depth = 1
        var i = start + openBytes.count
        while i < end, depth > 0 {
            if matches(bytes, at: i, openBytes) {
                depth += 1
                i += openBytes.count
            } else if matches(bytes, at: i, closeBytes) {
                depth -= 1
                if depth == 0 { return i }
                i += closeBytes.count
            } else {
                i += 1
            }
        }
        return end - closeBytes.count
    }

    /// `String.prototype.trim()` over an ASCII byte range. JS `trim` strips the same
    /// `\s` set as above plus line terminators; for ASCII tokens this is the JS `\s`
    /// set, applied at both ends.
    static func jsTrimAscii(_ bytes: [UInt8], _ start: Int, _ end: Int) -> String {
        var s = max(0, start)
        var e = min(bytes.count, end)
        while s < e, isPdfWhitespace(bytes[s]) { s += 1 }
        while e > s, isPdfWhitespace(bytes[e - 1]) { e -= 1 }
        return asciiString(bytes, s, e)
    }

    /// `/^(\d+)$/` — all ASCII digits, non-empty.
    static func isDigitsOnly(_ s: String) -> Bool {
        let bytes = Array(s.utf8)
        guard !bytes.isEmpty else { return false }
        return bytes.allSatisfy { isDigit($0) }
    }

    /// `/^-?\d+(?:\.\d+)?$/` — an optional leading `-`, integer digits, optional
    /// `.` + fractional digits.
    static func isIntegerOrDecimalLiteral(_ s: String) -> Bool {
        let bytes = Array(s.utf8)
        var i = 0
        let n = bytes.count
        guard n > 0 else { return false }
        if bytes[i] == 0x2D { i += 1 }  // '-'
        let intStart = i
        while i < n, isDigit(bytes[i]) { i += 1 }
        guard i > intStart else { return false }
        if i < n {
            guard bytes[i] == 0x2E else { return false }  // '.'
            i += 1
            let fracStart = i
            while i < n, isDigit(bytes[i]) { i += 1 }
            guard i > fracStart else { return false }
        }
        return i == n
    }

    /// `after.match(/^\s+(\d+)\s+R\b/)` starting at byte `index`: returns the gen
    /// digit string and the number of bytes consumed (the whole match length), or
    /// nil when the indirect-reference tail isn't present.
    static func matchRefRest(_ bytes: [UInt8], _ index: Int, _ end: Int) -> (gen: String, consumed: Int)? {
        var p = index
        let wsStart = p
        while p < end, isPdfWhitespace(bytes[p]) { p += 1 }
        guard p > wsStart else { return nil }  // \s+ requires ≥1
        let genStart = p
        while p < end, isDigit(bytes[p]) { p += 1 }
        guard p > genStart else { return nil }  // \d+
        let gen = asciiString(bytes, genStart, p)
        let ws2 = p
        while p < end, isPdfWhitespace(bytes[p]) { p += 1 }
        guard p > ws2 else { return nil }  // \s+
        guard p < end, bytes[p] == 0x52, isWordBoundaryAfter(bytes, p + 1) else { return nil }  // 'R' \b
        p += 1
        return (gen, p - index)
    }

    /// `Number.parseFloat(s)` — parse the leading numeric run of a string, ignoring
    /// leading whitespace, returning nil when no numeric prefix exists. Matches the
    /// JS lenient float parse (used only for ExtGState `ca` string values).
    static func jsParseFloat(_ s: String) -> Double? {
        let chars = Array(s.unicodeScalars)
        let n = chars.count
        func isAsciiDigit(_ u: Unicode.Scalar) -> Bool { u.value >= 0x30 && u.value <= 0x39 }
        var i = 0
        while i < n, chars[i] == " " || chars[i] == "\t" || chars[i] == "\n" || chars[i] == "\r" { i += 1 }
        var j = i
        if j < n, chars[j] == "+" || chars[j] == "-" { j += 1 }
        var sawDigit = false
        while j < n, isAsciiDigit(chars[j]) {
            j += 1
            sawDigit = true
        }
        if j < n, chars[j] == "." {
            j += 1
            while j < n, isAsciiDigit(chars[j]) {
                j += 1
                sawDigit = true
            }
        }
        if j < n, chars[j] == "e" || chars[j] == "E" {
            var k = j + 1
            if k < n, chars[k] == "+" || chars[k] == "-" { k += 1 }
            var expDigit = false
            while k < n, isAsciiDigit(chars[k]) {
                k += 1
                expDigit = true
            }
            if expDigit { j = k }
        }
        guard sawDigit else { return nil }
        return Double(String(String.UnicodeScalarView(chars[i ..< j])))
    }
}

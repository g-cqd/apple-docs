/// A string addressed in UTF-16 code units, as JavaScript strings are — so the paginator's slicing, searching,
/// and length budgets land on exactly the offsets Bun's would.
struct JSText: Sendable {
    let units: [UInt16]

    init(_ string: String) { units = Array(string.utf16) }
    init(units: ArraySlice<UInt16>) { self.units = Array(units) }

    var length: Int { units.count }
    var string: String { String(decoding: units, as: UTF16.self) }

    /// `slice(start, end)`.
    func slice(_ start: Int, _ end: Int? = nil) -> JSText {
        let lower = max(0, min(start, length))
        let upper = max(lower, min(end ?? length, length))
        return JSText(units: units[lower ..< upper])
    }

    /// `indexOf(needle, from)`.
    func indexOf(_ needle: JSText, from: Int = 0) -> Int {
        guard !needle.units.isEmpty else { return min(from, length) }
        guard needle.length <= length else { return -1 }
        var index = max(0, from)
        while index + needle.length <= length {
            if units[index] == needle.units[0], units[index ..< (index + needle.length)].elementsEqual(needle.units) {
                return index
            }
            index += 1
        }
        return -1
    }

    /// `lastIndexOf(needle)`.
    func lastIndexOf(_ needle: JSText) -> Int {
        guard needle.length <= length else { return -1 }
        var index = length - needle.length
        while index >= 0 {
            if units[index ..< (index + needle.length)].elementsEqual(needle.units) { return index }
            index -= 1
        }
        return -1
    }

    /// `trim()`.
    func trimmed() -> JSText {
        var lower = 0
        var upper = length
        while lower < upper, Self.isWhitespace(units[lower]) { lower += 1 }
        while upper > lower, Self.isWhitespace(units[upper - 1]) { upper -= 1 }
        return slice(lower, upper)
    }

    /// JavaScript `\s` for one code unit.
    static func isWhitespace(_ unit: UInt16) -> Bool {
        switch unit {
            case 0x09 ... 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
                true
            default: false
        }
    }
}

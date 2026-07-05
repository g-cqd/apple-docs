// Pure SFNT (TrueType/OpenType) header inspection + Apple font-filename parsing —
// the native port of src/resources/apple-fonts/sfnt.js. NO CoreText: it reads the
// OpenType table directory and the `fvar` table's bytes directly, so it behaves
// identically on macOS and Linux (the font-sync corpus step must be reproducible
// across CI runners). Best-effort throughout — any malformed/short file yields the
// static defaults (`isVariable = false`, no axes), matching the JS try/catch.

import Foundation

public enum FontInspect {
    // Apple's fixed typography vocabulary. Order matters for weight rendering
    // (Ultralight → Black); the UI lays pills out in this order.
    static let variants = ["Display", "Text", "Rounded", "ExtraLarge", "Large", "Medium", "Small"]
    static let weights = [
        "Ultralight", "Thin", "Light", "Regular", "Medium", "Semibold", "Bold", "Heavy", "Black"
    ]

    /// The structured fields of an Apple font file name (`parseFontFilename`).
    public struct Filename: Sendable, Equatable {
        public var variant: String?
        public var weight: String?
        public var italic: Bool
    }

    /// One variable-font design axis (an `fvar` entry).
    public struct Axis: Sendable, Equatable {
        public var tag: String
        public var min: Double
        public var def: Double
        public var max: Double
        public init(tag: String, min: Double, def: Double, max: Double) {
            self.tag = tag
            self.min = min
            self.def = def
            self.max = max
        }
    }

    /// Variability report: `axes` is empty for a static font.
    public struct SfntInfo: Sendable, Equatable {
        public var isVariable: Bool
        public var axes: [Axis]
    }

    /// Parse an Apple font file name into `(variant, weight, italic)`. Ports `parseFontFilename`:
    ///   `SF-Pro-Display-BoldItalic.otf` → (Display, Bold, italic)
    ///   `SF-Pro-Italic.ttf`             → (nil, nil, italic)
    ///   `NewYorkSmall-RegularItalic.otf`→ (Small, Regular, italic)
    ///   `SF-Mono-Bold.otf`              → (nil, Bold, false)
    ///   `SF-Pro.ttf`                    → (nil, nil, false)
    public static func parseFilename(_ fileName: String) -> Filename {
        let stem = stem(of: fileName)
        let dashIndex = stem.lastIndex(of: "-")
        let tail = dashIndex.map { String(stem[stem.index(after: $0)...]) } ?? stem

        // Peel a trailing "Italic" off the last token first.
        var italic = false
        var trailingWeightToken = tail
        if tail.lowercased().hasSuffix("italic") {
            italic = true
            trailingWeightToken = String(tail.dropLast("Italic".count))
        }
        let weight =
            trailingWeightToken.isEmpty
            ? nil : weights.first { $0.lowercased() == trailingWeightToken.lowercased() }

        // Variant is the second-to-last token — a dash-delimited token OR glued to the family
        // prefix (`NewYorkSmall`). Only meaningful when a weight token was found.
        var variant: String?
        if weight != nil, let dashIndex {
            let head = String(stem[..<dashIndex])
            let headTail = head.lastIndex(of: "-").map { String(head[head.index(after: $0)...]) } ?? head
            variant = variants.first { $0.lowercased() == headTail.lowercased() }
            if variant == nil {
                variant = variants.first { head.lowercased().hasSuffix($0.lowercased()) }
            }
        }
        return Filename(variant: variant, weight: weight, italic: italic)
    }

    /// Read a font's OpenType table directory + `fvar` table and report variability. Ports
    /// `inspectSfntFile`: TrueType collections (`ttcf`) are rejected (Apple ships only static `.ttc`),
    /// and any bounds/parse failure returns the static default.
    public static func inspectFile(_ path: String) -> SfntInfo {
        let stat = SfntInfo(isVariable: false, axes: [])
        guard let data = FileManager.default.contents(atPath: path) else { return stat }
        let bytes = [UInt8](data)
        guard bytes.count >= 12 else { return stat }
        // Reject TrueType collections (`ttcf` = 0x74746366) — a different, multi-font walk.
        if beU32(bytes, 0) == 0x7474_6366 { return stat }
        let numTables = Int(beU16(bytes, 4))
        guard numTables > 0, numTables <= 256 else { return stat }

        var fvarOffset = -1
        var fvarLength = 0
        for i in 0 ..< numTables {
            let entry = 12 + i * 16
            if entry + 16 > bytes.count { break }
            if tag4(bytes, entry) == "fvar" {
                fvarOffset = Int(beU32(bytes, entry + 8))
                fvarLength = Int(beU32(bytes, entry + 12))
                break
            }
        }
        guard fvarOffset >= 0, fvarLength >= 12, fvarOffset + fvarLength <= bytes.count else {
            // No `fvar` at all ⇒ static. A present-but-unreadable `fvar` ⇒ the JS returns static too.
            return fvarOffset < 0 ? stat : SfntInfo(isVariable: false, axes: [])
        }
        let offsetToAxes = Int(beU16(bytes, fvarOffset + 4))
        let axisCount = Int(beU16(bytes, fvarOffset + 8))
        let axisSize = Int(beU16(bytes, fvarOffset + 10))
        guard axisCount > 0, axisSize >= 20 else { return SfntInfo(isVariable: true, axes: []) }

        let fvarEnd = fvarOffset + fvarLength
        var axes: [Axis] = []
        axes.reserveCapacity(axisCount)
        for i in 0 ..< axisCount {
            let start = fvarOffset + offsetToAxes + i * axisSize
            if start + 20 > fvarEnd { break }
            axes.append(
                Axis(
                    tag: tag4(bytes, start),
                    min: Double(beI32(bytes, start + 4)) / 65536,
                    def: Double(beI32(bytes, start + 8)) / 65536,
                    max: Double(beI32(bytes, start + 12)) / 65536))
        }
        return SfntInfo(isVariable: true, axes: axes)
    }

    // MARK: - byte helpers (big-endian, the SFNT wire order)

    static func stem(of fileName: String) -> String {
        let base = (fileName as NSString).lastPathComponent
        let ext = (base as NSString).pathExtension
        return ext.isEmpty ? base : String(base.dropLast(ext.count + 1))
    }

    private static func beU16(_ b: [UInt8], _ o: Int) -> UInt16 {
        UInt16(b[o]) << 8 | UInt16(b[o + 1])
    }

    private static func beU32(_ b: [UInt8], _ o: Int) -> UInt32 {
        UInt32(b[o]) << 24 | UInt32(b[o + 1]) << 16 | UInt32(b[o + 2]) << 8 | UInt32(b[o + 3])
    }

    private static func beI32(_ b: [UInt8], _ o: Int) -> Int32 {
        Int32(bitPattern: beU32(b, o))
    }

    /// The 4-byte ASCII table/axis tag at `o` (e.g. `"fvar"`, `"wght"`).
    private static func tag4(_ b: [UInt8], _ o: Int) -> String {
        String(decoding: b[o ..< o + 4], as: UTF8.self)
    }
}

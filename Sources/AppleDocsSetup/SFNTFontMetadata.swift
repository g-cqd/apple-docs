import Foundation

/// Pure-Swift cross-platform SFNT (TrueType / OpenType) binary font inspector and Apple font
/// filename parser — requires zero CoreText/AppKit dependencies and runs identically on macOS and Linux.
///
/// Guards against corrupt or non-SFNT files before passing them to CoreText or HarfBuzz, and extracts
/// OpenType `fvar` variable font axes (`wght`, `wdth`, `opsz`, `GRAD`, …) in fixed-point 16.16 format.
public struct SFNTFontMetadata: Hashable, Sendable, Codable {
    /// Single OpenType `fvar` variation axis.
    public struct Axis: Hashable, Sendable, Codable {
        public let tag: String
        public let minValue: Double
        public let defaultValue: Double
        public let maxValue: Double

        public init(tag: String, minValue: Double, defaultValue: Double, maxValue: Double) {
            self.tag = tag
            self.minValue = minValue
            self.defaultValue = defaultValue
            self.maxValue = maxValue
        }
    }

    /// Structured tokens extracted from an Apple font filename (e.g. `SF-Pro-Display-BoldItalic.otf`).
    public struct ParsedName: Hashable, Sendable {
        public let variant: String?
        public let weight: String?
        public let italic: Bool

        public init(variant: String?, weight: String?, italic: Bool) {
            self.variant = variant
            self.weight = weight
            self.italic = italic
        }
    }

    public let isValidSFNT: Bool
    public let isVariable: Bool
    public let axes: [Axis]

    public init(isValidSFNT: Bool, isVariable: Bool, axes: [Axis]) {
        self.isValidSFNT = isValidSFNT
        self.isVariable = isVariable
        self.axes = axes
    }

    /// Fast 4-byte magic probe (`OTTO`, `ttcf`, `wOFF`, `wOF2`, or TrueType `00 01 00 00`).
    public static func isLikelySFNT(_ bytes: [UInt8]) -> Bool {
        guard bytes.count >= 4 else { return false }
        let magic = readUInt32BE(bytes, at: 0)
        return magic == 0x4F54_544F  // 'OTTO'
            || magic == 0x7474_6366  // 'ttcf'
            || magic == 0x774F_4646  // 'wOFF'
            || magic == 0x774F_4632  // 'wOF2'
            || magic == 0x0001_0000  // TrueType 1.0
    }

    /// Inspects raw SFNT font bytes for validity and OpenType `fvar` variable axes.
    public static func inspect(bytes: [UInt8]) -> Self {
        guard isLikelySFNT(bytes) else {
            return Self(isValidSFNT: false, isVariable: false, axes: [])
        }
        guard bytes.count >= 12 else {
            return Self(isValidSFNT: true, isVariable: false, axes: [])
        }
        let scaler = readUInt32BE(bytes, at: 0)
        if scaler == 0x7474_6366 {  // 'ttcf' collection
            return Self(isValidSFNT: true, isVariable: false, axes: [])
        }
        let tableCount = Int(readUInt16BE(bytes, at: 4))
        guard tableCount > 0, tableCount <= 256 else {
            return Self(isValidSFNT: true, isVariable: false, axes: [])
        }
        guard let fvar = findTable(named: "fvar", in: bytes, tableCount: tableCount) else {
            return Self(isValidSFNT: true, isVariable: false, axes: [])
        }
        let axes = parseFvarAxes(in: bytes, offset: fvar.offset, length: fvar.length)
        return Self(isValidSFNT: true, isVariable: true, axes: axes)
    }

    /// Inspects a font file on disk by reading its bytes safely.
    public static func inspect(fileAtPath path: String) -> Self {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe) else {
            return Self(isValidSFNT: false, isVariable: false, axes: [])
        }
        return inspect(bytes: Array(data))
    }

    /// Parses Apple's canonical font filename grammar into `(variant, weight, italic)`.
    public static func parseAppleFilename(_ fileName: String) -> ParsedName {
        let base = URL(fileURLWithPath: fileName).deletingPathExtension().lastPathComponent
        let dashIndex = base.lastIndex(of: "-")
        let tail = dashIndex.map { String(base[base.index(after: $0)...]) } ?? base

        var italic = false
        let weightToken: String
        if tail.lowercased().hasSuffix("italic") {
            italic = true
            weightToken = String(tail.dropLast("italic".count))
        } else {
            weightToken = tail
        }
        let weight = weightLookup[weightToken.lowercased()]

        var variant: String?
        if weight != nil, let dashIndex {
            let head = String(base[..<dashIndex])
            let headTail = head.split(separator: "-").last.map(String.init) ?? head
            variant = variantLookup[headTail.lowercased()]
            if variant == nil {
                let lowerHead = head.lowercased()
                variant = canonicalVariants.first { lowerHead.hasSuffix($0.lowercased()) }
            }
        }
        return ParsedName(variant: variant, weight: weight, italic: italic)
    }

    private static let canonicalVariants = [
        "Display", "Text", "Rounded", "ExtraLarge", "Large", "Medium", "Small"
    ]
    private static let canonicalWeights = [
        "Ultralight", "Thin", "Light", "Regular", "Medium", "Semibold", "Bold", "Heavy", "Black"
    ]
    private static let variantLookup = Dictionary(uniqueKeysWithValues: canonicalVariants.map { ($0.lowercased(), $0) })
    private static let weightLookup = Dictionary(uniqueKeysWithValues: canonicalWeights.map { ($0.lowercased(), $0) })

    private static func findTable(named target: String, in bytes: [UInt8], tableCount: Int) -> (
        offset: Int, length: Int
    )? {
        for idx in 0 ..< tableCount {
            let entry = 12 + idx * 16
            guard entry + 16 <= bytes.count else { break }
            let tag = String(decoding: bytes[entry ..< (entry + 4)], as: UTF8.self)
            if tag == target {
                let offset = Int(readUInt32BE(bytes, at: entry + 8))
                let length = Int(readUInt32BE(bytes, at: entry + 12))
                return (offset, length)
            }
        }
        return nil
    }

    private static func parseFvarAxes(in bytes: [UInt8], offset: Int, length: Int) -> [Axis] {
        guard offset >= 0, length >= 16, offset + length <= bytes.count else { return [] }
        let axesOffset = Int(readUInt16BE(bytes, at: offset + 4))
        let axisCount = Int(readUInt16BE(bytes, at: offset + 8))
        let axisSize = Int(readUInt16BE(bytes, at: offset + 10))
        guard axisCount > 0, axisSize >= 20 else { return [] }

        var axes: [Axis] = []
        axes.reserveCapacity(axisCount)
        for idx in 0 ..< axisCount {
            let start = offset + axesOffset + idx * axisSize
            guard start + 20 <= offset + length else { break }
            let tag = String(decoding: bytes[start ..< (start + 4)], as: UTF8.self)
            let minVal = Double(Int32(bitPattern: readUInt32BE(bytes, at: start + 4))) / 65_536.0
            let defVal = Double(Int32(bitPattern: readUInt32BE(bytes, at: start + 8))) / 65_536.0
            let maxVal = Double(Int32(bitPattern: readUInt32BE(bytes, at: start + 12))) / 65_536.0
            axes.append(Axis(tag: tag, minValue: minVal, defaultValue: defVal, maxValue: maxVal))
        }
        return axes
    }

    private static func readUInt16BE(_ bytes: [UInt8], at offset: Int) -> UInt16 {
        (UInt16(bytes[offset]) << 8) | UInt16(bytes[offset + 1])
    }

    private static func readUInt32BE(_ bytes: [UInt8], at offset: Int) -> UInt32 {
        (UInt32(bytes[offset]) << 24)
            | (UInt32(bytes[offset + 1]) << 16)
            | (UInt32(bytes[offset + 2]) << 8)
            | UInt32(bytes[offset + 3])
    }
}

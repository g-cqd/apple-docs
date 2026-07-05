// The native Apple font sync — the portable core of src/resources/apple-assets.js
// `syncAppleFonts`. Upserts the 8 Apple font families and indexes every discovered
// font file (variable-axis inspected via FontInspect) into apple_font_families /
// apple_font_files. The DMG download+extract half (`--download-fonts`, hdiutil) is
// macOS-only and opt-in; this default path — the 8 family rows + system-font
// discovery + already-extracted discovery — is pure Foundation and reproducible.

import ADBase  // Sha256 for the stable file id
import Foundation

/// One of Apple's 8 downloadable font families (the JS APPLE_FONT_FAMILIES rows).
public struct AppleFontFamilyDef: Sendable {
    public let id: String
    public let displayName: String
    public let category: String
    public let sourceUrl: String
    /// Case-insensitive `NSRegularExpression` pattern matching this family's file names.
    public let matchPattern: String
}

public enum FontSync {
    public static let families: [AppleFontFamilyDef] = [
        AppleFontFamilyDef(
            id: "sf-pro", displayName: "SF Pro", category: "sans-serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Pro.dmg",
            matchPattern: #"^SF-Pro(?:-|\.|$)|^SFNS"#),
        AppleFontFamilyDef(
            id: "sf-compact", displayName: "SF Compact", category: "sans-serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Compact.dmg",
            matchPattern: #"^SF-Compact(?:-|\.|$)|^SFCompact"#),
        AppleFontFamilyDef(
            id: "sf-mono", displayName: "SF Mono", category: "monospace",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Mono.dmg",
            matchPattern: #"^SF-Mono(?:-|\.|$)|^SFNSMono"#),
        AppleFontFamilyDef(
            id: "new-york", displayName: "New York", category: "serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/NY.dmg",
            matchPattern: #"^NewYork"#),
        AppleFontFamilyDef(
            id: "sf-arabic", displayName: "SF Arabic", category: "sans-serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Arabic.dmg",
            matchPattern: #"^SF-Arabic(?:-|\.|$)|^SFArabic"#),
        AppleFontFamilyDef(
            id: "sf-armenian", displayName: "SF Armenian", category: "sans-serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Armenian.dmg",
            matchPattern: #"^SF-Armenian(?:-|\.|$)|^SFArmenian"#),
        AppleFontFamilyDef(
            id: "sf-georgian", displayName: "SF Georgian", category: "sans-serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Georgian.dmg",
            matchPattern: #"^SF-Georgian(?:-|\.|$)|^SFGeorgian"#),
        AppleFontFamilyDef(
            id: "sf-hebrew", displayName: "SF Hebrew", category: "sans-serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Hebrew.dmg",
            matchPattern: #"^SF-Hebrew(?:-|\.|$)|^SFHebrew"#)
    ]

    /// The system font search roots (the JS DEFAULT_FONT_DIRS).
    static var defaultFontDirs: [String] {
        ["/Library/Fonts", "/System/Library/Fonts", "\(NSHomeDirectory())/Library/Fonts"]
    }

    private static let fontFilePattern = #"\.(ttf|otf|ttc|dfont)$"#

    /// A discovered font file: its leaf name + absolute path.
    public struct DiscoveredFont: Sendable, Equatable {
        public let fileName: String
        public let filePath: String
    }

    /// One-level directory walk for font files (the JS `discoverAppleFontFiles`). Missing dirs are
    /// skipped; entries are sorted so the index order is deterministic across runs.
    public static func discover(_ dirs: [String]) -> [DiscoveredFont] {
        var out: [DiscoveredFont] = []
        for dir in dirs {
            guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir) else { continue }
            for name in entries.sorted() where matches(name, fontFilePattern) {
                out.append(DiscoveredFont(fileName: name, filePath: "\(dir)/\(name)"))
            }
        }
        return out
    }

    /// The family whose match pattern accepts `fileName`, or nil.
    static func matchFamily(_ fileName: String) -> AppleFontFamilyDef? {
        families.first { matches(fileName, $0.matchPattern) }
    }

    static func matches(_ string: String, _ pattern: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else {
            return false
        }
        return regex.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)) != nil
    }

    /// The tallies `syncAppleFonts` returns.
    public struct Result: Sendable, Equatable {
        public var families = 0
        public var files = 0
        public var variable = 0
        public var system = 0
        public var remote = 0
    }

    /// Upsert the 8 families, then index every discovered font (already-extracted DMG files first — they
    /// win a `file_name` collision — then system fonts). Requires a writable `StorageConnection` whose
    /// schema is at AppleDocsSchema. `now` is the caller's ISO timestamp.
    @discardableResult
    public static func syncAppleFonts(_ db: StorageConnection, dataDir: String, now: String) -> Result {
        let extractedDir = "\(dataDir)/resources/fonts/extracted"
        var result = Result()
        result.families = families.count
        for family in families {
            db.upsertAppleFontFamily(
                AppleFontFamilyUpsert(
                    id: family.id, displayName: family.displayName, category: family.category,
                    sourceUrl: family.sourceUrl, extractedPath: "\(extractedDir)/\(family.id)",
                    status: "available"),
                updatedAt: now)
        }
        var remoteNames: Set<String> = []
        for file in discover([extractedDir]) {
            guard let family = matchFamily(file.fileName) else { continue }
            index(db, file, family: family, source: "remote", now: now, into: &result)
            remoteNames.insert("\(family.id):\(file.fileName)")
        }
        for file in discover(defaultFontDirs) {
            guard let family = matchFamily(file.fileName),
                !remoteNames.contains("\(family.id):\(file.fileName)")
            else { continue }
            index(db, file, family: family, source: "system", now: now, into: &result)
        }
        return result
    }

    private static func index(
        _ db: StorageConnection, _ file: DiscoveredFont, family: AppleFontFamilyDef, source: String,
        now: String, into result: inout Result
    ) {
        let parsed = FontInspect.parseFilename(file.fileName)
        let sfnt = FontInspect.inspectFile(file.filePath)
        let attrs = try? FileManager.default.attributesOfItem(atPath: file.filePath)
        let size = (attrs?[.size] as? NSNumber)?.int64Value
        let id = String(Sha256.hexString("\(family.id):\(file.fileName)").prefix(24))
        let format = (file.fileName as NSString).pathExtension.lowercased()
        let styleName = parsed.italic ? "\(parsed.weight ?? "Regular") Italic" : parsed.weight
        db.upsertAppleFontFile(
            AppleFontFileUpsert(
                id: id, familyId: family.id, fileName: file.fileName, filePath: file.filePath,
                styleName: styleName, weight: parsed.weight, variant: parsed.variant, italic: parsed.italic,
                format: format.isEmpty ? nil : format, source: source, isVariable: sfnt.isVariable,
                axesJson: axesJSON(sfnt.axes), sha256: nil, size: size),
            updatedAt: now)
        if sfnt.isVariable { result.variable += 1 }
        if source == "remote" { result.remote += 1 }
        if source == "system" { result.system += 1 }
        result.files += 1
    }

    /// JS-compatible axes JSON — `[]` for a static font, else
    /// `[{"tag":"wght","min":0,"default":400,"max":900}]`, integer values without a trailing `.0`
    /// (matching `JSON.stringify` of the JS axis objects, so the corpus row is byte-identical).
    static func axesJSON(_ axes: [FontInspect.Axis]) -> String {
        let items = axes.map { axis in
            "{\"tag\":\"\(axis.tag)\",\"min\":\(number(axis.min)),\"default\":\(number(axis.def)),"
                + "\"max\":\(number(axis.max))}"
        }
        return "[\(items.joined(separator: ","))]"
    }

    private static func number(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int64(value)) : String(value)
    }
}

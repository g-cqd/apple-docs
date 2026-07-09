// The SF Symbol catalog sync — the tractable half of src/resources/apple-symbols/sync.js
// `syncSfSymbols`: read Apple's CoreGlyphs.bundle plists (symbol_order / categories / search /
// name_aliases / name_availability) and upsert the sf_symbols catalog. The prerender half (a macOS
// Swift-worker pool that bakes each symbol into a theme-neutral SVG) is a separate, later step; the
// catalog rows are what /symbols search + the web build read. macOS-only: the bundle lives under
// /System/Library/PrivateFrameworks/SFSymbols.framework.

import Foundation

public enum SymbolSync {
    /// The public + private CoreGlyphs bundle resource dirs (the JS SYMBOL_BUNDLES).
    public static let bundles: [String: String] = [
        "public":
            "/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources"
            + "/CoreGlyphs.bundle/Contents/Resources",
        "private":
            "/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources"
            + "/CoreGlyphsPrivate.bundle/Contents/Resources"
    ]

    /// Catalog meta-entries that aren't real symbols (no drawable glyph) — filtered at ingest so they
    /// never enter sf_symbols (the JS CATALOG_META_NAMES).
    static let catalogMetaNames: Set<String> = ["symbols", "year_to_release"]

    /// Read a binary/XML plist into a Foundation object, or nil (best-effort, the JS readPlist).
    static func readPlist(_ path: String) -> Any? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)
    }

    /// Parse a `.strings` map (`"key" = "value";`) into `[key: value]` (the JS readStringsMap). `.strings`
    /// are old-style (openstep) plists, which PropertyListSerialization reads as a dict.
    static func readStringsMap(_ path: String) -> [String: String] {
        (readPlist(path) as? [String: String]) ?? [:]
    }

    /// Normalize a plist value to a string array (the JS normalizeStringArray).
    static func normalizeStringArray(_ value: Any?) -> [String] {
        if let array = value as? [Any] { return array.map { "\($0)" }.filter { !$0.isEmpty } }
        if let string = value as? String { return [string] }
        return []
    }

    /// Read the CoreGlyphs.bundle plists and upsert the sf_symbols catalog for `scope`. Returns the row
    /// count. `now` is the caller's ISO timestamp; a missing bundle is a warn-and-skip (returns 0).
    @discardableResult
    public static func syncSfSymbols(_ db: StorageConnection, scope rawScope: String, now: String) -> Int {
        let scope = rawScope == "private" ? "private" : "public"
        guard let bundleDir = bundles[scope], FileManager.default.fileExists(atPath: bundleDir) else {
            return 0
        }
        let order = (readPlist("\(bundleDir)/symbol_order.plist") as? [String]) ?? []
        let categories = (readPlist("\(bundleDir)/symbol_categories.plist") as? [String: Any]) ?? [:]
        let search = (readPlist("\(bundleDir)/symbol_search.plist") as? [String: Any]) ?? [:]
        let aliases = readStringsMap("\(bundleDir)/name_aliases.strings")
        let availability = (readPlist("\(bundleDir)/name_availability.plist") as? [String: Any]) ?? [:]
        let version = bundleVersion(of: (bundleDir as NSString).deletingLastPathComponent)

        var names = Set(order)
        names.formUnion(search.keys)
        names.formUnion(categories.keys)
        names.formUnion(availability.keys)
        names.subtract(catalogMetaNames)

        // Stable order: by the symbol_order index (fallback 999999), then name — the JS sort.
        let ordered = order.isEmpty ? names.sorted() : order
        var orderIndex: [String: Int] = [:]
        for (index, name) in ordered.enumerated() where orderIndex[name] == nil { orderIndex[name] = index }
        let sorted = names.sorted { first, second in
            let firstIndex = orderIndex[first] ?? 999_999
            let secondIndex = orderIndex[second] ?? 999_999
            return firstIndex != secondIndex ? firstIndex < secondIndex : first < second
        }

        var count = 0
        for name in sorted {
            let upserted = db.upsertSfSymbol(
                SfSymbolUpsert(
                    name: name, scope: scope,
                    categoriesJson: jsonStringArray(normalizeStringArray(categories[name])),
                    keywordsJson: jsonStringArray(normalizeStringArray(search[name])),
                    aliasesJson: jsonStringArray(normalizeStringArray(aliases[name])),
                    availabilityJson: availabilityJson(availability[name]),
                    orderIndex: orderIndex[name].map(Int64.init),
                    bundlePath: bundleDir, bundleVersion: version),
                updatedAt: now)
            // Count SUCCESSES only: an attempt-count silently masks a read-only or
            // constraint failure as a healthy sync (it did once -- the D-0007-4 cutover
            // ran the catalog sync through a query_only connection and reported 8,478
            // "synced" rows into an empty table).
            if upserted { count += 1 }
        }
        return count
    }

    /// The bundle's version from `<contents>/Info.plist` (CFBundleShortVersionString, else CFBundleVersion).
    static func bundleVersion(of contentsDir: String) -> String? {
        guard let info = readPlist("\(contentsDir)/Info.plist") as? [String: Any] else { return nil }
        return (info["CFBundleShortVersionString"] as? String) ?? (info["CFBundleVersion"] as? String)
    }

    /// `JSON.stringify` of a string array — `["a","b"]`, `[]` for empty.
    static func jsonStringArray(_ items: [String]) -> String {
        "[\(items.map { "\"\(jsonEscape($0))\"" }.joined(separator: ","))]"
    }

    /// The availability value as JSON — a string ⇒ a JSON string; anything else (incl. the nested
    /// `{symbols: …}` shape whose real names live one level down) ⇒ nil, matching the JS `x ?? null`.
    static func availabilityJson(_ value: Any?) -> String? {
        (value as? String).map { "\"\(jsonEscape($0))\"" }
    }

    private static func jsonEscape(_ string: String) -> String {
        var out = ""
        for scalar in string.unicodeScalars {
            switch scalar {
                case "\"": out += "\\\""
                case "\\": out += "\\\\"
                case "\n": out += "\\n"
                case "\t": out += "\\t"
                case "\r": out += "\\r"
                default:
                    if scalar.value < 0x20 {
                        out += String(format: "\\u%04x", scalar.value)
                    } else {
                        out.unicodeScalars.append(scalar)
                    }
            }
        }
        return out
    }
}

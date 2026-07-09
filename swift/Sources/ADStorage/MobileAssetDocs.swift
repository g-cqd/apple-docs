// Offline enrichment source: Xcode's Developer Documentation MobileAsset
// (`com.apple.MobileAsset.AppleDeveloperDocumentation`) — the native port of
// src/sources/mobileasset-docs.js. Xcode downloads a vector-search corpus to
// /System/Library/AssetsV2/…/<sha1>.asset/AssetData/documentation-db/index.sql —
// a SQLite DB with one JSON blob per page (`documents`) and rendered-Markdown
// chunks (`attributes`). The page JSON carries two things the crawled
// RenderJSON never exposes: the symbol's USR (`external_id`) and structured
// per-platform `introduced` data. This file is the discovery + pure-mapping
// half; the merge itself lives in MobileAssetDocs+Enrich.swift.
//
// The asset DB is opened read-only + immutable (`SQLiteConnection(immutableAssetPath:)`,
// the JS `openAssetDb`); nothing under /System is ever written.

import ADJSONCore
import Foundation

public enum MobileAssetDocs {
    /// The JS DEFAULT_ASSET_ROOT.
    public static let defaultAssetRoot =
        "/System/Library/AssetsV2/com_apple_MobileAsset_AppleDeveloperDocumentation"

    /// Apple platform display names → the project's platforms_json keys (the JS PLATFORM_KEYS).
    /// Names outside this map — including the asset's `"macCatalyst"` spelling, which the JS keys
    /// as `"Mac Catalyst"` and therefore never matches — are skipped, exactly like the JS.
    static let platformKeys: [String: String] = [
        "iOS": "ios",
        "iPadOS": "ipados",
        "Mac Catalyst": "maccatalyst",
        "macOS": "macos",
        "tvOS": "tvos",
        "visionOS": "visionos",
        "watchOS": "watchos"
    ]

    /// One installed documentation asset (the JS findDocumentationAssets element).
    public struct AssetInfo: Sendable, Equatable {
        public let assetPath: String
        public let dbPath: String
        /// COUNT(*) of the asset's `documents` table.
        public let docs: Int
    }

    /// List installed documentation assets, best (most documents) first (the JS
    /// `findDocumentationAssets`). An unreadable asset is skipped; a missing root yields [].
    public static func findDocumentationAssets(rootDir: String = defaultAssetRoot) -> [AssetInfo] {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: rootDir) else {
            return []
        }
        var out: [AssetInfo] = []
        for entry in entries.sorted() where entry.hasSuffix(".asset") {
            let dbPath = "\(rootDir)/\(entry)/AssetData/documentation-db/index.sql"
            guard FileManager.default.fileExists(atPath: dbPath) else { continue }
            guard let db = SQLiteConnection(immutableAssetPath: dbPath),
                let count = db.prepareUncached("SELECT COUNT(*) AS c FROM documents"),
                count.step() == SQLite.row
            else { continue }
            out.append(
                AssetInfo(assetPath: "\(rootDir)/\(entry)", dbPath: dbPath, docs: Int(count.int(0) ?? 0)))
        }
        // Most documents first; the entry name breaks ties deterministically (the JS sort is
        // stable over readdir order, which is filesystem-dependent).
        return out.sorted { $0.docs != $1.docs ? $0.docs > $1.docs : $0.assetPath < $1.assetPath }
    }

    /// `/documentation/SwiftUI/View` → `swiftui/view` (the project's key shape — the JS
    /// `normalizeAssetUri`).
    static func normalizeAssetUri(_ uri: String) -> String {
        var s = uri
        if s.hasPrefix("/") { s.removeFirst() }  // JS replace(/^\//, '') — one leading slash
        if s.lowercased().hasPrefix("documentation/") {
            s = String(s.dropFirst("documentation/".count))
        }
        return s.lowercased()
    }

    /// The project-shaped platform projection (the JS `platformsToProject` result object).
    public struct ProjectPlatforms: Sendable, Equatable {
        public let platformsJson: String
        public let minIos: String?
        public let minMacos: String?
        public let minWatchos: String?
        public let minTvos: String?
        public let minVisionos: String?
    }

    /// Apple `platforms[]` → `{ platformsJson, minIos, … }` (the JS `platformsToProject`): keep the
    /// mapped platforms whose `introduced` formats, in array order (the JS object insertion order,
    /// so `platformsJson` is byte-identical to the JS `JSON.stringify(map)`); nil when none match.
    static func platformsToProject(_ platforms: JSON?) -> ProjectPlatforms? {
        guard let items = platforms?.array, !items.isEmpty else { return nil }
        var ordered: [(key: String, text: String)] = []
        var mins: [String: String] = [:]
        for platform in items {
            guard let name = platform["platform"].string, let key = platformKeys[name],
                let introduced = numberValue(platform["introduced"]),
                let text = formatVersion(introduced)
            else { continue }
            if let index = ordered.firstIndex(where: { $0.key == key }) {
                ordered[index].text = text  // a duplicate platform overwrites (JS map[key] = text)
            } else {
                ordered.append((key, text))
            }
            mins[key] = text
        }
        guard !ordered.isEmpty else { return nil }
        // Keys and version texts are [a-z0-9.] by construction — no JSON escaping needed.
        let json = "{" + ordered.map { "\"\($0.key)\":\"\($0.text)\"" }.joined(separator: ",") + "}"
        return ProjectPlatforms(
            platformsJson: json, minIos: mins["ios"], minMacos: mins["macos"],
            minWatchos: mins["watchos"], minTvos: mins["tvos"], minVisionos: mins["visionos"])
    }

    /// The JS `Number(v)` coercion for the asset's `introduced` field: a JSON number passes
    /// through; a numeric string parses; anything else is nil (→ the platform is skipped).
    static func numberValue(_ value: JSON) -> Double? {
        if let double = value.double { return double }
        if let string = value.string { return Double(string) }
        return nil
    }

    /// 13 → "13.0", 10.15 → "10.15" (the JS `formatVersion` — matches the crawl's version strings).
    /// Apple ships `introduced` as JSON floats carrying IEEE-754 noise — 17.2 arrives as
    /// 17.199999999999999 — so round to 2 decimals (the depth of a real major.minor) and strip
    /// trailing zeros instead of stringifying raw.
    static func formatVersion(_ value: Double) -> String? {
        guard value.isFinite, value > 0 else { return nil }
        var s = String(format: "%.2f", value)  // toFixed(2); unlocalized
        while s.hasSuffix("0") { s.removeLast() }  // the JS replace(/\.?0+$/, '')
        if s.hasSuffix(".") { s.removeLast() }
        return s.contains(".") ? s : s + ".0"
    }

    /// `s:` → swift, `c:` → occ, else nil (the JS `languageFromUsr`).
    static func languageFromUsr(_ usr: String?) -> String? {
        guard let usr else { return nil }
        if usr.hasPrefix("s:") { return "swift" }
        if usr.hasPrefix("c:") { return "occ" }
        return nil
    }

    /// `lib/version-encode.js` `encodeVersion` — MAJOR*1e6 + MINOR*1e3 + PATCH, nil for missing /
    /// unparseable input; components must be in [0, 1000). The same port lives in
    /// `CrawlPersist.encodeVersionNumber` (ADWrite) — duplicated here because ADStorage cannot
    /// import ADWrite without inverting the module layering.
    static func encodeVersion(_ text: String?) -> Int64? {
        guard let text else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let numeric = leadingVersion(trimmed) else { return nil }
        let parts = numeric.split(separator: ".").map { Int($0) }
        guard parts.allSatisfy({ $0 != nil }) else { return nil }
        let ints = parts.compactMap { $0 }
        guard ints.allSatisfy({ $0 >= 0 && $0 < 1_000 }) else { return nil }
        let minor = ints.count > 1 ? ints[1] : 0
        let patch = ints.count > 2 ? ints[2] : 0
        return Int64(ints[0]) * 1_000_000 + Int64(minor) * 1_000 + Int64(patch)
    }

    /// The leading `^\d+(?:\.\d+){0,3}` match of the JS encodeVersion regex, or nil when the
    /// string does not start with a digit.
    private static func leadingVersion(_ s: String) -> String? {
        var out = ""
        var groups = 0  // `.\d+` groups consumed beyond the first component
        var index = s.startIndex
        while index < s.endIndex, s[index].isNumber {
            out.append(s[index])
            index = s.index(after: index)
        }
        guard !out.isEmpty else { return nil }
        while groups < 3, index < s.endIndex, s[index] == "." {
            let afterDot = s.index(after: index)
            guard afterDot < s.endIndex, s[afterDot].isNumber else { break }
            out.append(".")
            index = afterDot
            while index < s.endIndex, s[index].isNumber {
                out.append(s[index])
                index = s.index(after: index)
            }
            groups += 1
        }
        return out
    }

    /// `storage/source-types.js` `deriveRootSourceType(slug, kind)` for the enrich `upsertRoot`
    /// (slug map first, then kind, then the default) — the same map
    /// `CrawlPersist.deriveRootSourceType` carries on the ADWrite side.
    static func deriveRootSourceType(slug: String, kind: String) -> String {
        let bySlug: [String: String] = [
            "app-store-review": "guidelines", "design": "hig", "apple-archive": "apple-archive",
            "packages": "packages", "sample-code": "sample-code", "swift-book": "swift-book",
            "swift-evolution": "swift-evolution", "swift-org": "swift-org", "wwdc": "wwdc"
        ]
        if let mapped = bySlug[slug] { return mapped }
        if kind == "guidelines" { return "guidelines" }
        if kind == "design" { return "hig" }
        return "apple-docc"
    }

    /// `repos/documents.js` `deriveFrameworkFromPath` — `documentation/<fw>/…` → `<fw>`, else the
    /// first non-empty segment, else nil.
    static func deriveFrameworkFromPath(_ path: String) -> String? {
        guard !path.isEmpty else { return nil }
        let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        if parts.first == "documentation" { return parts.count > 1 ? parts[1] : nil }
        return parts.first
    }
}

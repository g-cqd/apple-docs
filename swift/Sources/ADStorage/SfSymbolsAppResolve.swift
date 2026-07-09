// Locate a usable SF Symbols.app — the native port of the on-disk discovery in
// src/resources/apple-symbols/codepoint-dump.js `resolveSymbolFontPath` +
// src/resources/sf-symbols-app/install.js `readInstalledVersion` / the "prefer the
// system install" half of `ensureSfSymbolsApp`. The codepoint reader needs three
// things from the bundle — the `SFSymbolsFallback.otf` font, the two private
// frameworks (`SFSymbolsShared` + its nested `CoreGlyphsLib`, which exports the
// `Crypton` table decryptor), and the SYSTEM catalog metadata dir — so resolution
// validates all four exist before returning; a missing piece means "skip, don't
// stamp" upstream, never a crash.
//
// Candidate order mirrors the JS (explicit path first, then /Applications) plus two
// host-reality additions: `SF Symbols Beta.app` (the bundle SF Symbols 8 actually
// installs — the JS only knew `SF Symbols.app`) and the `<dataDir>/cache/sf-symbols`
// download cache. The system metadata dir is app-independent (the JS `METADATA_DIR`).

import Foundation

/// A validated SF Symbols.app: the paths the codepoint reader compiles + links against, plus the
/// bundle version stamped alongside each codepoint (`CFBundleShortVersionString`).
public struct SfSymbolsApp: Sendable, Equatable {
    /// Absolute path to the `.app` bundle.
    public let appPath: String
    /// `Contents/Resources/Fonts/SFSymbolsFallback.otf` — the obfuscated catalog font.
    public let fontPath: String
    /// The SYSTEM catalog metadata dir (plists + the encrypted `metadata.store`).
    public let metadataDir: String
    /// `Contents/Frameworks` — holds `SFSymbolsShared.framework` (the `-F`/rpath root).
    public let sharedFrameworkDir: String
    /// `SFSymbolsShared.framework/Versions/A/Frameworks` — holds the nested `CoreGlyphsLib.framework`.
    public let glyphsLibFrameworkDir: String
    /// `CFBundleShortVersionString` (e.g. `8.0`), or nil when the Info.plist is unreadable.
    public let version: String?

    /// The app major (`version`'s first dotted segment) — drives the `MetadataReadingOptions` ABI
    /// gate. Falls back to the latest known major (8) when the version is unreadable, since we only
    /// ever resolve a current app (the JS `appMajorVersion` fallback).
    public var major: Int {
        guard let version, let first = version.split(separator: ".").first, let value = Int(first), value > 0
        else { return 8 }
        return value
    }
}

/// On-disk SF Symbols.app discovery + version reading. Pure filesystem — no spawn, no network.
public enum SfSymbolsAppLocator {
    /// The catalog metadata lives in the system framework, independent of which app is targeted
    /// (the JS `METADATA_DIR`). The Resources are plain plists + the encrypted `metadata.store`.
    public static let systemMetadataDir =
        "/System/Library/PrivateFrameworks/SFSymbols.framework/Resources/metadata"

    /// The bundle names SF Symbols ships under: the canonical stable app and the beta bundle SF
    /// Symbols 8 installs (`SF_SYMBOLS_APP_RE` in the JS `dmg-helpers.js`).
    static let applicationsCandidates = [
        "/Applications/SF Symbols.app",
        "/Applications/SF Symbols Beta.app"
    ]

    /// Resolve the first usable app across: `explicitAppPath` (tests / `--app-path`), the
    /// `/Applications` installs, then every `<dataDir>/cache/sf-symbols/<version>/SF Symbols.app`
    /// download. Returns nil when none has all four required pieces on disk — the caller then warns
    /// and stamps nothing (the JS `resolveSymbolFontPath` → null → "skip" branch).
    public static func resolve(dataDir: String?, explicitAppPath: String? = nil) -> SfSymbolsApp? {
        for candidate in candidates(dataDir: dataDir, explicitAppPath: explicitAppPath) {
            if let app = validate(appPath: candidate) { return app }
        }
        return nil
    }

    /// The candidate app paths in priority order. An explicit path is AUTHORITATIVE — the only
    /// candidate, no `/Applications` fallback — so an operator override is honored rather than silently
    /// swapped for a different install, and a deliberately-bogus `--app-path` exercises the "no app →
    /// skip" degradation edge. Absent an explicit path, discovery is `/Applications` then the cache.
    static func candidates(dataDir: String?, explicitAppPath: String?) -> [String] {
        if let explicitAppPath, !explicitAppPath.isEmpty { return [explicitAppPath] }
        var out: [String] = []
        out.append(contentsOf: applicationsCandidates)
        if let dataDir {
            let cacheRoot = "\(dataDir)/cache/sf-symbols"
            if let versions = try? FileManager.default.contentsOfDirectory(atPath: cacheRoot) {
                for version in versions.sorted() {
                    out.append("\(cacheRoot)/\(version)/SF Symbols.app")
                }
            }
        }
        return out
    }

    /// Build + existence-check every path a given bundle must expose; nil when any is missing
    /// (the JS `pathsForApp` + the four `existsSync` guards in `resolveSymbolFontPath`).
    static func validate(appPath: String) -> SfSymbolsApp? {
        let fontPath = "\(appPath)/Contents/Resources/Fonts/SFSymbolsFallback.otf"
        let sharedFrameworkDir = "\(appPath)/Contents/Frameworks"
        let sharedFramework = "\(sharedFrameworkDir)/SFSymbolsShared.framework"
        let glyphsLibFrameworkDir = "\(sharedFramework)/Versions/A/Frameworks"
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: fontPath),
            fileManager.fileExists(atPath: sharedFramework),
            fileManager.fileExists(atPath: "\(glyphsLibFrameworkDir)/CoreGlyphsLib.framework"),
            fileManager.fileExists(atPath: systemMetadataDir)
        else { return nil }
        return SfSymbolsApp(
            appPath: appPath, fontPath: fontPath, metadataDir: systemMetadataDir,
            sharedFrameworkDir: sharedFrameworkDir, glyphsLibFrameworkDir: glyphsLibFrameworkDir,
            version: readInstalledVersion(appPath: appPath))
    }

    /// `CFBundleShortVersionString` from the bundle's `Info.plist`, or nil when absent/unreadable
    /// (the JS `readInstalledVersion`, read directly via `PropertyListSerialization` — no `defaults`
    /// subprocess needed).
    static func readInstalledVersion(appPath: String) -> String? {
        let plistPath = "\(appPath)/Contents/Info.plist"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: plistPath)),
            let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
            let root = plist as? [String: Any],
            let short = root["CFBundleShortVersionString"] as? String
        else { return nil }
        let trimmed = short.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

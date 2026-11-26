public import AppleDocsSetup
import Foundation

/// Locates macOS-only Apple documentation & asset authoring inputs (CoreGlyphs SF Symbols bundle,
/// SF Symbols.app, and Xcode DocumentationCache / MobileAsset bundles).
///
/// Compiles cleanly on both macOS and Linux: on non-macOS hosts every probe returns `nil` or throws
/// ``SetupError/unsupportedOnPlatform(feature:)``, preserving a single cross-platform binary.
public enum DarwinAssetLocator: Sendable {
    /// Discovered local Apple authoring bundle paths on a macOS host.
    public struct Discovery: Hashable, Sendable {
        public let coreGlyphsBundlePath: String?
        public let sfSymbolsAppPath: String?
        public let xcodeDocumentationCachePath: String?

        public init(
            coreGlyphsBundlePath: String? = nil,
            sfSymbolsAppPath: String? = nil,
            xcodeDocumentationCachePath: String? = nil
        ) {
            self.coreGlyphsBundlePath = coreGlyphsBundlePath
            self.sfSymbolsAppPath = sfSymbolsAppPath
            self.xcodeDocumentationCachePath = xcodeDocumentationCachePath
        }
    }

    /// Standard macOS search candidates for CoreGlyphs.bundle.
    public static let coreGlyphsCandidates: [String] = [
        "/System/Library/CoreServices/CoreGlyphs.bundle",
        "/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/CoreGlyphs.bundle"
    ]

    /// Standard macOS search candidates for SF Symbols.app.
    public static let sfSymbolsAppCandidates: [String] = [
        "/Applications/SF Symbols.app",
        "/Applications/SF Symbols beta.app"
    ]

    /// Probes the current host for installed Apple authoring bundles.
    public static func discover() -> Discovery {
        #if os(macOS)
            let fm = FileManager.default
            let coreGlyphs = coreGlyphsCandidates.first { fm.fileExists(atPath: $0) }
            let sfApp = sfSymbolsAppCandidates.first { fm.fileExists(atPath: $0) }
            let homeCache = URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Developer/Xcode/DocumentationCache", isDirectory: true)
                .path
            let xcodeCache = fm.fileExists(atPath: homeCache) ? homeCache : nil
            return Discovery(
                coreGlyphsBundlePath: coreGlyphs,
                sfSymbolsAppPath: sfApp,
                xcodeDocumentationCachePath: xcodeCache
            )
        #else
            return Discovery()
        #endif
    }

    /// Verifies that CoreGlyphs is available on macOS, or throws a typed ``SetupError``.
    public static func requireCoreGlyphsBundle() throws(SetupError) -> String {
        #if os(macOS)
            guard let path = discover().coreGlyphsBundlePath else {
                throw .missingHostTool("CoreGlyphs.bundle")
            }
            return path
        #else
            throw .unsupportedOnPlatform(feature: "CoreGlyphs SF Symbols extraction")
        #endif
    }
}

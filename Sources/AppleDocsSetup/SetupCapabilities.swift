/// Setup capabilities available on the active host operating system.
///
/// Runtime serving and snapshot installation run on both macOS and Linux;
/// macOS-only authoring tasks (CoreGlyphs extraction, SF Symbols prerendering,
/// CoreText text shaping, DMG/pkg unpacking, local Xcode MobileAsset enrichment)
/// are supplied by `AppleDocsSetupDarwin` on macOS hosts.
public struct SetupCapabilities: Hashable, Sendable {
    public let supportsSnapshotInstall: Bool
    public let supportsUpstreamCrawl: Bool
    public let supportsCoreGlyphsPrerender: Bool
    public let supportsAppleDMGExtract: Bool
    public let supportsLocalXcodeMobileAsset: Bool

    public init(
        supportsSnapshotInstall: Bool,
        supportsUpstreamCrawl: Bool,
        supportsCoreGlyphsPrerender: Bool,
        supportsAppleDMGExtract: Bool,
        supportsLocalXcodeMobileAsset: Bool
    ) {
        self.supportsSnapshotInstall = supportsSnapshotInstall
        self.supportsUpstreamCrawl = supportsUpstreamCrawl
        self.supportsCoreGlyphsPrerender = supportsCoreGlyphsPrerender
        self.supportsAppleDMGExtract = supportsAppleDMGExtract
        self.supportsLocalXcodeMobileAsset = supportsLocalXcodeMobileAsset
    }

    /// Baseline cross-platform setup capabilities available on Linux and macOS alike.
    public static let crossPlatform = Self(
        supportsSnapshotInstall: true,
        supportsUpstreamCrawl: true,
        supportsCoreGlyphsPrerender: false,
        supportsAppleDMGExtract: false,
        supportsLocalXcodeMobileAsset: false
    )
}

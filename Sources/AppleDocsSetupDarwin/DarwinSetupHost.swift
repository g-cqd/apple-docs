public import AppleDocsSetup

/// Host capability probe isolating macOS-only setup features behind `#if os(macOS)`.
public enum DarwinSetupHost: Sendable {
    /// Returns the setup capabilities supported by the current host OS.
    public static var capabilities: SetupCapabilities {
        #if os(macOS)
            SetupCapabilities(
                supportsSnapshotInstall: true,
                supportsUpstreamCrawl: true,
                supportsCoreGlyphsPrerender: true,
                supportsAppleDMGExtract: true,
                supportsLocalXcodeMobileAsset: true
            )
        #else
            .crossPlatform
        #endif
    }
}

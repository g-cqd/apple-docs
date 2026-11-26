public import AppleDocsCore
public import AppleDocsSetup
public import AppleDocsSetupDarwin

/// Snapshot of runtime version and host setup capabilities reported by `status`.
public struct RuntimeStatus: Hashable, Sendable {
    public let version: String
    public let capabilities: SetupCapabilities

    public init(
        version: String = AppleDocsVersion.current,
        capabilities: SetupCapabilities = DarwinSetupHost.capabilities
    ) {
        self.version = version
        self.capabilities = capabilities
    }
}

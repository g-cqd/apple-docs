public import AppleDocsSetup

/// Safe wrapper around macOS-only `hdiutil` and `pkgutil` for Apple Font DMG/PKG extraction.
///
/// Always passes argv arrays via ``ScrubbedSubprocess`` (zero shell interpolation) and fails
/// explicitly with ``SetupError/unsupportedOnPlatform(feature:)`` on Linux.
public enum DarwinDiskImageAdapter: Sendable {
    /// Lists payload files inside a macOS `.pkg` archive without executing installer scripts.
    public static func listPackagePayload(pkgPath: String) async throws(SetupError) -> [String] {
        #if os(macOS)
            let outcome = try await ScrubbedSubprocess.run(
                executable: "/usr/sbin/pkgutil",
                arguments: ["--payload-files", pkgPath]
            )
            guard outcome.exitCode == 0 else {
                throw .commandFailed(tool: "pkgutil", exitCode: outcome.exitCode, stderr: outcome.stderr)
            }
            return outcome.stdout
                .split(separator: "\n", omittingEmptySubsequences: true)
                .map(String.init)
        #else
            _ = pkgPath
            throw .unsupportedOnPlatform(feature: "macOS .pkg inspection via pkgutil")
        #endif
    }
}

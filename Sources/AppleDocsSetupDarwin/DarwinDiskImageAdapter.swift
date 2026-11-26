public import AppleDocsSetup
import Foundation

/// Safe wrapper around macOS-only `hdiutil` and `pkgutil` for Apple Font DMG/PKG extraction.
///
/// Always passes argv arrays via ``ScrubbedSubprocess`` (zero shell interpolation), mounts DMGs
/// read-only (`-nobrowse -readonly`) into an isolated temporary mountpoint, and detaches on exit.
/// Compiles cleanly on Linux and fails with ``SetupError/unsupportedOnPlatform(feature:)``.
public enum DarwinDiskImageAdapter: Sendable {
    /// Lists payload files inside a macOS `.pkg` archive without executing installer scripts.
    public static func listPackagePayload(pkgPath: String) async throws(SetupError) -> [String] {
        #if os(macOS)
            let stdout = try await ScrubbedSubprocess.runChecked(
                executable: "/usr/sbin/pkgutil",
                arguments: ["--payload-files", pkgPath],
                toolLabel: "pkgutil"
            )
            return
                stdout
                .split(separator: "\n", omittingEmptySubsequences: true)
                .map(String.init)
        #else
            _ = pkgPath
            throw .unsupportedOnPlatform(feature: "macOS .pkg inspection via pkgutil")
        #endif
    }

    /// Mounts a `.dmg` read-only (`-nobrowse -readonly`), executes `body(mountPoint)`, and always detaches.
    public static func withMountedDMG<T: Sendable>(
        dmgPath: String,
        _ body: @Sendable (String) async throws -> T
    ) async throws -> T {
        #if os(macOS)
            let mountPoint = FileManager.default.temporaryDirectory
                .appendingPathComponent("apple-docs-dmg-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: mountPoint, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: mountPoint) }

            _ = try await ScrubbedSubprocess.runChecked(
                executable: "/usr/bin/hdiutil",
                arguments: ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint.path, dmgPath],
                toolLabel: "hdiutil"
            )
            do {
                let result = try await body(mountPoint.path)
                _ = try? await ScrubbedSubprocess.run(
                    executable: "/usr/bin/hdiutil",
                    arguments: ["detach", "-quiet", mountPoint.path]
                )
                return result
            } catch {
                _ = try? await ScrubbedSubprocess.run(
                    executable: "/usr/bin/hdiutil",
                    arguments: ["detach", "-force", "-quiet", mountPoint.path]
                )
                throw error
            }
        #else
            _ = (dmgPath, body)
            throw SetupError.unsupportedOnPlatform(feature: "macOS .dmg mounting via hdiutil")
        #endif
    }

    /// Expands a `.pkg` into `destinationDirectory` via `pkgutil --expand-full` without running installer scripts.
    public static func expandPackage(pkgPath: String, into destinationDirectory: String) async throws(SetupError) {
        #if os(macOS)
            _ = try await ScrubbedSubprocess.runChecked(
                executable: "/usr/sbin/pkgutil",
                arguments: ["--expand-full", pkgPath, destinationDirectory],
                toolLabel: "pkgutil"
            )
        #else
            _ = (pkgPath, destinationDirectory)
            throw .unsupportedOnPlatform(feature: "macOS .pkg expansion via pkgutil")
        #endif
    }
}

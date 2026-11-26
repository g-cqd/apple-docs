import Foundation

#if canImport(Darwin)
    import Darwin
#elseif canImport(Glibc)
    import Glibc
#endif

/// Cross-platform corpus snapshot installer enforcing the full security & durability pipeline:
/// 1. Mandatory SHA-256 checksum verification (``SnapshotVerifier``) before inspecting the archive.
/// 2. Pre-extraction archive member listing + traversal/link/allowlist/size validation (``ArchiveSafetyValidator``).
/// 3. Scrubbed-environment extraction into an isolated staging directory (``ScrubbedSubprocess``).
/// 4. Atomic replacement into the target data directory followed by `fsync` on the parent directory
///    so a sudden power loss cannot revert replaced corpus entries.
public enum SnapshotInstaller: Sendable {
    /// Allowed top-level entries inside an official `apple-docs` corpus snapshot archive.
    public static let allowedTopLevelEntries: Set<String> = [
        "apple-docs.db",
        "apple-docs-v1.db",
        "resources",
        "models",
        "manifest.json"
    ]

    /// Verifies, validates, and extracts a local `.tar.zst` or `.tar.gz` archive into `destinationDirectory`.
    public static func installLocalArchive(
        archivePath: String,
        expectedSHA256Text: String,
        into destinationDirectory: String
    ) async throws(SetupError) {
        try SnapshotVerifier.verifyFile(atPath: archivePath, against: expectedSHA256Text)
        let members = try await listTarMembers(archivePath: archivePath)
        try ArchiveSafetyValidator.validate(
            members: members,
            allowedTopLevelPrefixes: allowedTopLevelEntries
        )

        let fm = FileManager.default
        let destURL = URL(fileURLWithPath: destinationDirectory, isDirectory: true)
        let stageURL = destURL.appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
        do {
            try fm.createDirectory(at: stageURL, withIntermediateDirectories: true)
        } catch {
            throw .ioFailure("Unable to prepare staging directory under \(destinationDirectory): \(error)")
        }
        defer { try? fm.removeItem(at: stageURL) }

        let extractArgs = tarArguments(for: archivePath, extractTo: stageURL.path)
        _ = try await ScrubbedSubprocess.runChecked(executable: "tar", arguments: extractArgs)

        do {
            let entries = try fm.contentsOfDirectory(at: stageURL, includingPropertiesForKeys: nil)
            for staged in entries {
                let finalURL = destURL.appendingPathComponent(staged.lastPathComponent)
                if fm.fileExists(atPath: finalURL.path) {
                    _ = try fm.replaceItemAt(finalURL, withItemAt: staged)
                } else {
                    try fm.moveItem(at: staged, to: finalURL)
                }
            }
        } catch {
            throw .ioFailure("Failed promoting staged snapshot files: \(error)")
        }
        try syncDirectory(atPath: destURL.path)
    }

    private static func listTarMembers(archivePath: String) async throws(SetupError) -> [ArchiveSafetyValidator.Member]
    {
        let stdout = try await ScrubbedSubprocess.runChecked(
            executable: "tar",
            arguments: tarArguments(for: archivePath, extractTo: nil)
        )
        return
            stdout
            .split(separator: "\n", omittingEmptySubsequences: true)
            .compactMap(parseVerboseTarLine)
    }

    private static func tarArguments(for archivePath: String, extractTo directory: String?) -> [String] {
        var args: [String] = archivePath.lowercased().hasSuffix(".zst") ? ["--use-compress-program", "zstd"] : []
        if let directory {
            args.append(contentsOf: ["-xf", archivePath, "-C", directory])
        } else {
            args.append(contentsOf: ["-tvf", archivePath])
        }
        return args
    }

    private static func parseVerboseTarLine(_ line: Substring) -> ArchiveSafetyValidator.Member? {
        guard let first = line.first else { return nil }
        let kind: ArchiveSafetyValidator.MemberKind =
            switch first {
                case "-": .regularFile
                case "d": .directory
                case "l": .symlink
                case "h": .hardlink
                default: .special
            }
        let tokens = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
        guard let rawName = tokens.last else { return nil }
        return ArchiveSafetyValidator.Member(path: String(rawName), kind: kind)
    }

    private static func syncDirectory(atPath path: String) throws(SetupError) {
        let fd = open(path, O_RDONLY)
        guard fd >= 0 else {
            throw .ioFailure("Unable to open directory for fsync: \(path)")
        }
        defer { _ = close(fd) }
        _ = fsync(fd)
    }
}

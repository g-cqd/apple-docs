import AppleDocsCommands
import AppleDocsSetup
import ArgumentParser
import Foundation

/// `apple-docs snapshot` command group (`create`, `verify`, `install`).
struct SnapshotSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "snapshot",
        abstract: "Create, verify, or atomically install offline corpus snapshots.",
        subcommands: [
            SnapshotCreateSubcommand.self,
            SnapshotVerifySubcommand.self,
            SnapshotInstallSubcommand.self
        ]
    )
}

// @dl:accept -- ArgumentParser subcommand declarations share the ParsableCommand shape
private struct SnapshotCreateSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "create",
        abstract: "Compact a Swift v1 corpus database via VACUUM INTO and pack a verified archive + .sha256."
    )

    // @dl:accept -- ArgumentParser @Argument/@Option declarations share the ParsableCommand shape
    @Argument(help: "Destination archive path (e.g. corpus.tar.zst or corpus.tar.gz).")
    var outputArchive: String

    @Option(name: .long, help: "Source Swift v1 corpus database path.")
    var db: String?

    @Option(name: .long, help: "Optional resources directory to bundle alongside the database.")
    var resources: String?

    @Option(name: .long, help: "Compression format: zstd or gzip.")
    var compression = "gzip"

    func run() async throws {
        guard let codec = SnapshotBuilder.Compression(rawValue: compression.lowercased()) else {
            throw ValidationError("Unsupported compression '\(compression)'; expected zstd or gzip.")
        }
        let result = try await SnapshotBuilder.create(
            databasePath: db ?? CorpusPaths.defaultDatabasePath(),
            outputArchivePath: outputArchive,
            compression: codec,
            includeResourcesDirectory: resources
        )
        print("Created \(result.archivePath) (\(result.archiveBytes) bytes, \(result.documentCount) docs)")
        print("SHA-256: \(result.sha256Hex) -> \(result.checksumPath)")
    }
}

// @dl:accept -- ArgumentParser subcommand declarations share the ParsableCommand shape
private struct SnapshotVerifySubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "verify",
        abstract: "Verify a snapshot archive against its .sha256 sidecar file."
    )

    @Argument(help: "Path to the snapshot archive.")
    var archivePath: String

    @Option(name: .shortAndLong, help: "Path to the .sha256 file (defaults to <archive>.sha256).")
    var checksumFile: String?

    func run() throws {
        let sidecarPath = checksumFile ?? "\(archivePath).sha256"
        let expected = try String(contentsOfFile: sidecarPath, encoding: .utf8)
        try SnapshotVerifier.verifyFile(atPath: archivePath, against: expected)
        print("Verified OK: \(archivePath)")
    }
}

// @dl:accept -- ArgumentParser subcommand declarations share the ParsableCommand shape
private struct SnapshotInstallSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "install",
        abstract: "Verify SHA-256, validate tar safety, and atomically install a snapshot archive."
    )

    // @dl:accept -- ArgumentParser @Argument/@Option declarations share the ParsableCommand shape
    @Argument(help: "Path to the local snapshot archive (.tar.zst or .tar.gz).")
    var archivePath: String

    @Option(name: .shortAndLong, help: "Path to the .sha256 sidecar file (defaults to <archive>.sha256).")
    var checksumFile: String?

    @Option(name: .shortAndLong, help: "Target data directory (defaults to APPLE_DOCS_HOME).")
    var destination: String?

    func run() async throws {
        let sidecarPath = checksumFile ?? "\(archivePath).sha256"
        let expected = try String(contentsOfFile: sidecarPath, encoding: .utf8)
        let targetDir = destination ?? CorpusPaths.defaultDataDirectory()
        try await SnapshotInstaller.installLocalArchive(
            archivePath: archivePath,
            expectedSHA256Text: expected,
            into: targetDir
        )
        print("Installed snapshot into \(targetDir)")
    }
}

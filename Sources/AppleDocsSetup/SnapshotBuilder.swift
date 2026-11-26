import AppleDocsCore
import AppleDocsStorage
import Foundation

/// Creates verifiable, compacted corpus snapshots (`.tar.zst` or `.tar.gz`) plus `.sha256` sidecars
/// using SQLite `VACUUM INTO` (with `temp_store = FILE`), `manifest.json`, and scrubbed `tar`
/// invocations so snapshots are deterministic and cross-platform on macOS and Linux.
public enum SnapshotBuilder: Sendable {
    /// Archive compression format for generated corpus snapshots.
    public enum Compression: String, Hashable, Sendable {
        case zstd
        case gzip

        public var fileExtension: String {
            switch self {
                case .zstd: "tar.zst"
                case .gzip: "tar.gz"
            }
        }
    }

    /// Output artifact paths and integrity metadata returned by ``create(databasePath:outputArchivePath:compression:includeResourcesDirectory:)``.
    public struct BuildResult: Hashable, Sendable {
        public let archivePath: String
        public let checksumPath: String
        public let sha256Hex: String
        public let archiveBytes: Int64
        public let documentCount: Int
    }

    /// Builds a compacted snapshot archive and companion `.sha256` file from a Swift v1 corpus database.
    public static func create(
        databasePath: String,
        outputArchivePath: String,
        compression: Compression = .gzip,
        includeResourcesDirectory: String? = nil
    ) async throws(SetupError) -> BuildResult {
        let archiveURL = URL(fileURLWithPath: outputArchivePath).standardizedFileURL
        return try await SetupScratchDirectory.withDirectory(
            prefix: ".snap-build",
            under: archiveURL.deletingLastPathComponent()
        ) { stageURL throws(SetupError) in
            let (docCount, entries) = try stageContents(
                databasePath: databasePath,
                resourcesDirectory: includeResourcesDirectory,
                into: stageURL
            )
            let tarArgs = packArguments(
                compression: compression,
                archivePath: archiveURL.path,
                stagePath: stageURL.path,
                entries: entries
            )
            _ = try await ScrubbedSubprocess.runChecked(executable: "tar", arguments: tarArgs)
            return try writeChecksumSidecar(for: archiveURL, documentCount: docCount)
        }
    }

    /// Checks available free disk space on the volume containing `path` against `minimumBytes`.
    public static func hasAvailableDiskSpace(atPath path: String, minimumBytes: Int64) -> Bool {
        let target =
            FileManager.default.fileExists(atPath: path)
            ? path
            : URL(fileURLWithPath: path).deletingLastPathComponent().path
        guard let attrs = try? FileManager.default.attributesOfFileSystem(forPath: target),
            let free = (attrs[.systemFreeSize] as? NSNumber)?.int64Value
        else {
            return true
        }
        return free >= minimumBytes
    }

    private static func stageContents(
        databasePath: String,
        resourcesDirectory: String?,
        into stageURL: URL
    ) throws(SetupError) -> (Int, [String]) {
        let stagedDB = stageURL.appendingPathComponent("apple-docs-v1.db").path
        let docCount: Int
        do {
            let conn = try SQLiteConnection(path: databasePath, options: .readOnly)
            defer { conn.close() }
            try conn.vacuumInto(destinationPath: stagedDB)
            let countRow = try conn.queryOne("SELECT COUNT(*) FROM documents")
            docCount = Int(try countRow?.integer(at: 0) ?? 0)
        } catch {
            throw .ioFailure("VACUUM INTO snapshot failed: \(error)")
        }

        var entries = ["apple-docs-v1.db", "manifest.json"]
        let manifest =
            "{\"schema\":\(CorpusSchemaV1.userVersion),\"version\":\"\(AppleDocsVersion.current)\",\"documents\":\(docCount)}\n"
        do {
            try Data(manifest.utf8).write(to: stageURL.appendingPathComponent("manifest.json"), options: .atomic)
            if let resourcesPath = resourcesDirectory, FileManager.default.fileExists(atPath: resourcesPath) {
                try FileManager.default.copyItem(
                    at: URL(fileURLWithPath: resourcesPath, isDirectory: true),
                    to: stageURL.appendingPathComponent("resources", isDirectory: true)
                )
                entries.append("resources")
            }
        } catch {
            throw .ioFailure("Unable to stage snapshot metadata/resources: \(error)")
        }
        return (docCount, entries)
    }

    private static func packArguments(
        compression: Compression,
        archivePath: String,
        stagePath: String,
        entries: [String]
    ) -> [String] {
        let base: [String] =
            switch compression {
                case .zstd: ["--use-compress-program", "zstd", "-cf", archivePath, "-C", stagePath]
                case .gzip: ["-czf", archivePath, "-C", stagePath]
            }
        return base + entries
    }

    private static func writeChecksumSidecar(for archiveURL: URL, documentCount: Int) throws(SetupError) -> BuildResult
    {
        let digest = try SnapshotVerifier.sha256Hex(fileAtPath: archiveURL.path)
        let checksumPath = "\(archiveURL.path).sha256"
        let sidecar = "\(digest)  \(archiveURL.lastPathComponent)\n"
        let sizeBytes: Int64
        do {
            try Data(sidecar.utf8).write(to: URL(fileURLWithPath: checksumPath), options: .atomic)
            let attrs = try FileManager.default.attributesOfItem(atPath: archiveURL.path)
            sizeBytes = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        } catch {
            throw .ioFailure("Unable to write checksum sidecar: \(error)")
        }
        return BuildResult(
            archivePath: archiveURL.path,
            checksumPath: checksumPath,
            sha256Hex: digest,
            archiveBytes: sizeBytes,
            documentCount: documentCount
        )
    }
}

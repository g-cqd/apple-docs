// `ad-cli setup` — install the apple-docs corpus from a GitHub release snapshot
// (or a local archive). The native port of src/commands/setup.js's install path:
// resolve the latest release → stream-download the snapshot .tar.zst → verify its
// sha256 against the sidecar → safely extract it → rebuild the (snapshot-omitted)
// embedding index → apply the storage profile → stamp provenance. Reuses the F1
// streaming download (ADOps.GhRelease.downloadToFile) + F2 safe extraction
// (ADArchive.TarZst) + the shared index path (IndexEmbeddings).
//
// Deferred sub-gaps (documented): `--beta` channel policy (stable only here); the
// font/symbol resource resync (the snapshot ships the resource index); the
// prebuilt/compact profile materialize/compact steps (this sets the profile key;
// the materialize/compact verbs run those). Snapshots ship no vectors, so the
// index rebuild is required for semantic search — but it needs an ADDB corpus, so
// a SQLite snapshot degrades to lexical-only (never blocks the install).

import ADArchive
import ADJSONCore
import ADOps
import ADStorage
import ADWrite
import ArgumentParser
import Foundation

struct SetupCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "setup",
        abstract: "Install the apple-docs corpus from a GitHub release snapshot (or a local archive).")

    @Option(name: .long, help: "Install directory (default: $APPLE_DOCS_HOME or ~/.apple-docs).")
    var home: String?

    @Option(name: .long, help: "GitHub repo to fetch the snapshot release from.")
    var repo = "g-cqd/apple-docs"

    @Option(name: .long, help: "Install from a local .tar.zst/.tar.gz archive instead of a release.")
    var archive: String?

    @Flag(name: .long, help: "Reinstall over an existing corpus.")
    var force = false

    @Flag(name: .customLong("skip-semantic"), help: "Skip the embedding-index rebuild (lexical search only).")
    var skipSemantic = false

    @Option(name: .long, help: "Storage profile: compact, balanced (default), or prebuilt.")
    var profile = "balanced"

    @Flag(name: .long, help: "Emit the result as JSON.")
    var json = false

    // swiftlint:disable:next function_body_length
    func run() async throws {
        let defaultHome = "\(NSHomeDirectory())/.apple-docs"
        let dataDir = home ?? ProcessInfo.processInfo.environment["APPLE_DOCS_HOME"] ?? defaultHome
        let dbPath = "\(dataDir)/apple-docs.db"

        guard StorageProfile.all[profile] != nil else {
            fail("Unknown storage profile: \"\(profile)\". Valid: \(StorageProfile.names.joined(separator: ", "))")
        }

        // Already installed (unless --force): report and stop, like setup.js.
        if !force, FileManager.default.fileExists(atPath: dbPath), let existing = StorageConnection(path: dbPath),
            existing.storageTableCounts().documents > 0
        {
            emit(
                SetupResult(
                    status: "exists", source: nil, tag: nil,
                    documentCount: Int(existing.storageTableCounts().documents),
                    storageProfile: StorageProfile.active(existing), semantic: nil, dataDir: dataDir))
            return
        }

        // ── acquire the archive ──────────────────────────────────────────────
        var tag: String?
        var source = "local-archive"
        let archivePath: String
        var tempDownload: String?
        if let archive {
            archivePath = archive
        } else {
            source = "github-release"
            let fetcher = URLSessionGhFetcher()
            log("Fetching latest release from \(repo)…")
            let release = try await GhRelease.fetchLatest(repo, fetcher: fetcher)
            tag = release.tagName
            log("Found \(release.tagName) (\(release.publishedAt)).")
            let assets = try GhRelease.pickSnapshotAssets(release)
            let expected = try await GhRelease.fetchSha256Sidecar(assets.checksum.url, fetcher: fetcher)
            try FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
            let tmp = "\(dataDir)/.setup-download-\(assets.archive.name)"
            let sizeStr = formatBytes(Int64(assets.archive.size))
            log("Downloading \(assets.archive.name) (\(sizeStr))…")
            let downloaded = try await GhRelease.downloadToFile(assets.archive.url, to: tmp)
            guard downloaded.sha256 == expected.lowercased() else {
                try? FileManager.default.removeItem(atPath: tmp)
                fail(
                    "Checksum mismatch for \(assets.archive.name): expected "
                        + "\(expected.prefix(16))…, got \(downloaded.sha256.prefix(16))…")
            }
            log("Checksum verified.")
            archivePath = tmp
            tempDownload = tmp
        }
        defer { if let tempDownload { try? FileManager.default.removeItem(atPath: tempDownload) } }

        // Clean stale install artifacts on a --force reinstall (fresh install has none).
        if force {
            for path in [
                dbPath, "\(dbPath)-wal", "\(dbPath)-shm", "\(dataDir)/raw-json", "\(dataDir)/markdown",
                "\(dataDir)/resources/symbols"
            ] {
                try? FileManager.default.removeItem(atPath: path)
            }
        }

        // ── extract (safe: member audit + bounded-memory zstd, F2) ───────────
        try FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
        log("Extracting snapshot…")
        do {
            try TarZst.extract(archivePath: archivePath, into: dataDir)
        } catch let error as ArchiveExtractError {
            fail("Extraction failed: \(error.message)")
        }

        guard let corpus = StorageConnection(path: dbPath) else {
            fail("Extracted corpus not found or unreadable at \(dbPath).")
        }
        let documentCount = Int(corpus.storageTableCounts().documents)

        // ── semantic index (snapshots ship no vectors). ADDB-only; a SQLite
        //    snapshot degrades to lexical-only (import → index later). ──────────
        var semantic = "skipped"
        if !skipSemantic {
            do {
                let database = try openCrawlCorpus(dbPath)
                let embedder = try loadIndexEmbedder(dbPath: dbPath)
                log("Building semantic index (a few minutes; --skip-semantic to skip)…")
                let indexed = try IndexEmbeddings.run(database, embedder: embedder, full: true)
                semantic = "ok (\(indexed.indexed)/\(indexed.total) docs, \(indexed.chunks) chunks)"
            } catch {
                semantic =
                    "lexical-only (semantic index needs an ADDB corpus — run `ad-cli import` then `ad-cli index`)"
                log("Semantic index skipped: \(error)")
            }
        }

        // ── profile + provenance stamps ──────────────────────────────────────
        if let writer = StorageConnection(path: dbPath, writable: true) {
            _ = writer.setSnapshotMeta("storage_profile", profile)
            if let tag { _ = writer.setSnapshotMeta("snapshot_tag", tag) }
            _ = writer.setSnapshotMeta("snapshot_installed_at", isoNow())
        }

        emit(
            SetupResult(
                status: "ok", source: source, tag: tag, documentCount: documentCount, storageProfile: profile,
                semantic: semantic, dataDir: dataDir))
    }

    // MARK: - output

    private func emit(_ result: SetupResult) {
        if json {
            print(stringifyPretty(result.json))
        } else {
            print(result.humanLines)
        }
    }

    /// stderr progress line (human runs only; JSON stays clean on stdout).
    private func log(_ message: String) {
        if !json { FileHandle.standardError.write(Data("\(message)\n".utf8)) }
    }

    /// Write an error to stderr and exit 1.
    private func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("Error: \(message)\n".utf8))
        Foundation.exit(1)
    }
}

/// The install outcome — the fields of the JS `{ status, source?, tag?,
/// documentCount, storageProfile, dataDir }` return, plus a `semantic` note.
struct SetupResult {
    let status: String
    let source: String?
    let tag: String?
    let documentCount: Int
    let storageProfile: String
    let semantic: String?
    let dataDir: String

    var json: JSONValue {
        var pairs: [(String, JSONValue)] = [("status", .string(status))]
        if let source { pairs.append(("source", .string(source))) }
        if let tag { pairs.append(("tag", .string(tag))) }
        pairs.append(("documentCount", .int(Int64(documentCount))))
        pairs.append(("storageProfile", .string(storageProfile)))
        if let semantic { pairs.append(("semantic", .string(semantic))) }
        pairs.append(("dataDir", .string(dataDir)))
        return .obj(pairs)
    }

    var humanLines: String {
        var lines: [String]
        if status == "exists" {
            lines = ["Corpus already installed at \(dataDir) (\(documentCount) documents, profile: \(storageProfile))."]
            lines.append("Run `ad-cli setup --force` to reinstall.")
        } else {
            lines = ["Setup complete — \(documentCount) documents ready at \(dataDir) (profile: \(storageProfile))."]
            if let tag { lines.append("Snapshot: \(tag).") }
            if let semantic { lines.append("Semantic index: \(semantic).") }
        }
        return lines.joined(separator: "\n")
    }
}

/// `new Date().toISOString()` — ISO-8601 UTC with millisecond precision.
private func isoNow() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

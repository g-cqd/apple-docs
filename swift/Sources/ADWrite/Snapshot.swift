import ADArchive
// Snapshot — the native apple-docs SNAPSHOT build on the ADDB engine ("ADSQLv0").
// The port of `snapshotBuild` (apple-docs/src/commands/snapshot.js): it packages the
// corpus as a single deterministic `.tar.zst` artifact alongside a `manifest.json`
// and a `.sha256` sidecar.
//
// Pipeline (mirrors snapshot.js):
//   1. validate the corpus + the `--tag` (strict allow-list, no path-escape).
//   2. copy the DB to a staging dir via the ADDB engine's `snapshot(to:)` — the
//      VACUUM-INTO equivalent (an atomic clone of the newest committed generation).
//   3. truncate the OPERATIONAL (`crawl_state`/`activity`/`update_log`) and
//      REGENERABLE (`document_chunks`/`document_vectors`) tables, and drop the
//      `embed_*` meta (the installed DB rebuilds vectors locally from sections).
//   4. write the 7 `snapshot_meta` keys with a TAG-DERIVED deterministic
//      `snapshot_created_at`, so two builds of the same tag bake identical bytes.
//   5. (DEFERRED) embed the raw upstream payloads (zstd) into `document_raw` — see
//      the note on `embedRawPayloads`; needs a one-shot zstd-compress in ADArchive.
//   6. compute the DB sha256 + size; write `manifest.json` into the staging dir.
//   7. stage `resources/{symbols,fonts,models}` (when present).
//   8. clamp EVERY staged file's mtime to a tag-derived constant — `ArchiveWriter`
//      embeds each member's integer-seconds mtime, so any drift would break the
//      determinism gate.
//   9. archive the staging dir as a deterministic `.tar.zst` (byte-sorted member
//      list, pinned zstd params) via `ADArchive.ArchiveWriter.writeTarZst`.
//  10. compute the archive sha256 + size; write the `.sha256` sidecar + the output
//      `manifest.json` (with the archive checksum/size added).
//
// Determinism (the gate): same `tag` + same source DB ⇒ byte-identical `.tar.zst`
// across two builds. This rests on (a) the tag-derived createdAt/mtimes, (b) the
// sorted member list + pinned zstd, and (c) the ADDB snapshot DB being byte-stable
// for the same committed generation + the same truncation/meta writes.
//
// `import Foundation`: the snapshot is a build-tool operation (mkdtemp, tree copy,
// mtime clamp, streamed hashing) — unlike the Foundation-free write path
// (CrawlPersist/Schema/IndexEmbeddings), it needs FileManager/FileHandle. This pulls
// Foundation into ADWrite, but ADWrite is NOT in the zero-dep ADCore dylib graph, so
// the dylib's no-Foundation property is unaffected.
public import ADDB
import ADSQLModel
import Crypto
import Foundation

#if canImport(Darwin)
    import Darwin  // mkdtemp, errno
#else
    import Glibc
#endif

/// The native snapshot builder — a namespace of pure build functions over an open,
/// writable ADDB `Database` (the live corpus) plus a data directory.
public enum Snapshot {
    /// The fixed snapshot tier. The single shape rules out half-broken consumers.
    static let tier = "full"

    /// Operational tables truncated (not dropped — the reader reopens them).
    static let operationalTruncate = ["crawl_state", "activity", "update_log"]
    /// Regenerable tables truncated (rebuilt on the device from sections + model).
    static let regenerableTruncate = ["document_chunks", "document_vectors"]

    /// One snapshot build's outcome (the fields a CLI verb / the determinism gate
    /// needs). All paths are absolute.
    public struct Result: Sendable, Equatable {
        public let tag: String
        public let documentCount: Int
        public let dbSize: Int64
        public let dbChecksum: String
        public let archivePath: String
        public let archiveName: String
        public let archiveSize: Int64
        public let archiveChecksum: String
        public let checksumSidecarPath: String
        public let manifestPath: String
    }

    public enum SnapshotError: Error, CustomStringConvertible, Equatable {
        case invalidTag(String)
        case emptyCorpus
        case archive(String)
        case io(String)

        public var description: String {
            switch self {
                case .invalidTag(let tag): return "Invalid --tag \"\(tag)\": must match [a-z0-9._-]{1,64}"
                case .emptyCorpus: return "Corpus is empty. Run sync first."
                case .archive(let message): return "snapshot archive failed: \(message)"
                case .io(let message): return "snapshot io failed: \(message)"
            }
        }
    }

    /// Build a snapshot archive from the current corpus.
    ///
    /// - Parameters:
    ///   - db: the open, writable ADDB database (the live corpus). It is cloned via
    ///     `snapshot(to:)`; the clone — never `db` — is the one mutated.
    ///   - dataDir: the data directory whose `resources/{symbols,fonts,models}` are
    ///     staged into the archive (when present). `nil` ⇒ DB-only snapshot.
    ///   - outDir: the directory the `.tar.zst` + sidecar + manifest are written to.
    ///   - tag: the snapshot tag (`[a-z0-9._-]{1,64}`); a `snapshot-YYYYMMDD` tag
    ///     yields the deterministic createdAt/mtime.
    ///   - schemaVersion: the corpus schema version (the migrator knows it) — recorded
    ///     in `snapshot_meta` + the manifest.
    ///   - level: the zstd compression level (JS uses `-9`).
    ///   - workers: the zstd worker-thread count (JS uses `-T3`).
    /// - Throws: a ``SnapshotError`` on an invalid tag, or a ``DBError`` on a clone/write failure.
    /// - Returns: the build ``Result``.
    @discardableResult
    public static func build(
        _ db: Database,
        dataDir: String?,
        outDir: String,
        tag: String,
        schemaVersion: Int64,
        level: Int32 = 9,
        workers: Int32 = 3
    ) throws -> Result {
        guard isValidTag(tag) else { throw SnapshotError.invalidTag(tag) }
        let createdAt = deterministicCreatedAt(tag)
        let stableMtime = deterministicMtimeSeconds(tag)

        let fileManager = FileManager.default
        let buildDir = try makeStagingDir(fileManager)
        defer { try? fileManager.removeItem(atPath: buildDir) }

        // 2. Copy the DB via the engine's snapshot (VACUUM-INTO equivalent). The
        // destination must not exist (the clone's contract), and buildDir is fresh.
        let copyPath = buildDir + "/apple-docs.db"
        do {
            try db.snapshot(to: copyPath)
        } catch {
            throw SnapshotError.io("snapshot(to:) failed: \(error)")
        }

        // 3-5. Truncate + meta + raw-json embedding on the COPY (never the live db).
        let documentCount = try stampCopy(
            copyPath, dataDir: dataDir, tag: tag, createdAt: createdAt, schemaVersion: schemaVersion)

        // 6. DB checksum + size, then the in-archive manifest.
        let dbSize = try fileSize(copyPath)
        let dbChecksum = try sha256Hex(ofFile: copyPath)
        let manifestInfo = ManifestInfo(
            tag: tag, schemaVersion: schemaVersion, createdAt: createdAt,
            documentCount: documentCount, dbChecksum: dbChecksum, dbSize: dbSize)
        try writeManifest(buildDir + "/manifest.json", manifestInfo, archive: nil)

        // 7. Stage resources/{symbols,fonts,models} when present.
        if let dataDir {
            try stageResources(from: dataDir, into: buildDir, fileManager)
        }

        // 8. Clamp EVERY staged file's mtime so the tar member headers are stable.
        let relativeFiles = try sortedRelativeFiles(buildDir, fileManager)
        for relative in relativeFiles {
            try clampMtime(buildDir + "/" + relative, to: stableMtime, fileManager)
        }

        // 9. Deterministic .tar.zst.
        try ensureDirectory(outDir, fileManager)
        let archiveName = "apple-docs-\(tier)-\(tag).tar.zst"
        let archivePath = outDir + "/" + archiveName
        let request = ArchiveRequest(
            sourceDir: buildDir, outputPath: archivePath, files: relativeFiles,
            level: level, workers: workers)
        switch ArchiveWriter.writeTarZst(request) {
            case .success: break
            case .failure(let failure): throw SnapshotError.archive(failure.message)
        }

        // 10. Archive checksum + size; sidecar + output manifest.
        let archiveSize = try fileSize(archivePath)
        let archiveChecksum = try sha256Hex(ofFile: archivePath)
        let checksumSidecarPath = archivePath + ".sha256"
        try writeText("\(archiveChecksum)  \(archiveName)\n", to: checksumSidecarPath)
        let manifestPath = outDir + "/apple-docs-\(tier)-\(tag).manifest.json"
        try writeManifest(
            manifestPath, manifestInfo,
            archive: (size: archiveSize, checksum: archiveChecksum))

        return Result(
            tag: tag, documentCount: documentCount, dbSize: dbSize, dbChecksum: dbChecksum,
            archivePath: archivePath, archiveName: archiveName, archiveSize: archiveSize,
            archiveChecksum: archiveChecksum, checksumSidecarPath: checksumSidecarPath,
            manifestPath: manifestPath)
    }

    // MARK: - copy stamping (truncate + meta)

    /// Truncate the operational + regenerable tables on the cloned DB, drop the
    /// `embed_*` meta, and write the 7 `snapshot_meta` keys. Returns the document
    /// count. The clone is opened writable and closed before archiving.
    private static func stampCopy(
        _ copyPath: String, dataDir: String?, tag: String, createdAt: String, schemaVersion: Int64
    ) throws -> Int {
        let copyDb = try Database.open(at: copyPath, options: DatabaseOptions())
        defer { copyDb.close() }

        var documentCount = 0
        try copyDb.transaction { (txn) throws(DBError) in
            for table in operationalTruncate + regenerableTruncate {
                try txn.run("DELETE FROM \(table)")
            }
            // Vector meta describes rows we just stripped — drop it so the installed
            // DB's embed_* meta always comes from the local rebuild.
            for key in ["embed_dims", "embed_model", "embed_version"] {
                try txn.run("DELETE FROM snapshot_meta WHERE key = $k", ["k": .text(key)])
            }
        }

        documentCount = try scalarInt(copyDb, "SELECT COUNT(*) AS c FROM documents")
        let pageCount = try scalarInt(copyDb, "SELECT COUNT(*) AS c FROM pages WHERE status = 'active'")

        let meta: [(String, String)] = [
            ("snapshot_version", tag),
            ("snapshot_tier", tier),
            ("snapshot_created_at", createdAt),
            ("snapshot_schema_version", String(schemaVersion)),
            ("snapshot_document_count", String(documentCount)),
            ("snapshot_page_count", String(pageCount))
        ]
        try copyDb.transaction { (txn) throws(DBError) in
            for (key, value) in meta {
                try txn.run(
                    "INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES ($k, $v)",
                    ["k": .text(key), "v": .text(value)])
            }
        }
        // Embed the raw upstream payloads (zstd) into `document_raw` so the single
        // artifact carries everything (snapshot.js step 4b). For each document, read
        // `<dataDir>/raw-json/<keyPath>.json` and store `encodeRaw` of it — a zstd
        // frame (magic 28 b5 2f fd) when it's smaller than the UTF-8 bytes, else the
        // plain bytes. The reader (ADStorage Enrichment/ReadDoc) inflates magic-
        // prefixed blobs and best-effort-UTF-8-decodes the rest. Absent ⇒ skip.
        if let dataDir {
            try embedRawPayloads(copyDb, dataDir: dataDir)
        }
        return documentCount
    }

    /// `document_raw` embedding: one row per document whose raw-json file exists,
    /// encoded zstd-or-plain. Reads happen outside the write transaction; the inserts
    /// commit once (deterministic: stable `id` order + fixed-level zstd). Internal so
    /// the gate can drive it directly (the snapshot's copy DB is staged + discarded).
    static func embedRawPayloads(_ copyDb: Database, dataDir: String) throws {
        let rows = try copyDb.prepare("SELECT id, key FROM documents ORDER BY id").all()
        var payloads: [(id: Int64, bytes: [UInt8])] = []
        for row in rows {
            guard case .integer(let id) = row["id"], case .text(let key) = row["key"],
                let path = rawJsonPath(dataDir: dataDir, key: key),
                let text = try? String(contentsOfFile: path, encoding: .utf8)
            else { continue }
            payloads.append((id, encodeRaw(text)))
        }
        guard !payloads.isEmpty else { return }
        try copyDb.transaction { (txn) throws(DBError) in
            for payload in payloads {
                try txn.run(
                    "INSERT OR REPLACE INTO document_raw(document_id, raw) VALUES ($id, $raw)",
                    ["id": .integer(payload.id), "raw": .blob(payload.bytes)])
            }
        }
    }

    /// `encodeSectionContent` for `document_raw`: zstd-compress and keep it only when
    /// it actually saves bytes (tiny rows stay plain), exactly as the JS codec does.
    /// Both branches yield a BLOB (ADDB strict typing; `document_raw.raw` is BLOB).
    static func encodeRaw(_ text: String) -> [UInt8] {
        let raw = Array(text.utf8)
        if raw.isEmpty { return [] }
        if let compressed = ZstdEncoder.compress(raw), compressed.count < raw.count {
            return compressed
        }
        return raw
    }

    // MARK: - resources staging

    /// Stage `resources/{symbols,fonts/extracted,models}` from `dataDir` into the
    /// build tree (when each exists). `copyItem` clones (APFS) where possible.
    private static func stageResources(
        from dataDir: String, into buildDir: String, _ fileManager: FileManager
    ) throws {
        let subdirs = ["resources/symbols", "resources/fonts/extracted", "resources/models"]
        for relative in subdirs {
            let source = dataDir + "/" + relative
            var isDir: ObjCBool = false
            guard fileManager.fileExists(atPath: source, isDirectory: &isDir), isDir.boolValue
            else { continue }
            let destination = buildDir + "/" + relative
            try ensureDirectory((destination as NSString).deletingLastPathComponent, fileManager)
            do {
                try fileManager.copyItem(atPath: source, toPath: destination)
            } catch {
                throw SnapshotError.io("staging \(relative): \(error)")
            }
        }
    }

    // MARK: - filesystem + hashing helpers

    private static func makeStagingDir(_ fileManager: FileManager) throws -> String {
        let template = NSTemporaryDirectory() + "apple-docs-snapshot-XXXXXX"
        var bytes = Array(template.utf8) + [0]
        let path = bytes.withUnsafeMutableBufferPointer { buffer -> String? in
            buffer.baseAddress.flatMap { mkdtemp($0) }.map { String(cString: $0) }
        }
        guard let path else { throw SnapshotError.io("mkdtemp failed: errno \(errno)") }
        return path
    }

    private static func ensureDirectory(_ path: String, _ fileManager: FileManager) throws {
        do {
            try fileManager.createDirectory(atPath: path, withIntermediateDirectories: true)
        } catch {
            throw SnapshotError.io("mkdir \(path): \(error)")
        }
    }

    /// Every regular file under `root`, as `root`-relative paths, deterministically
    /// sorted (the order `ArchiveWriter` archives them in).
    private static func sortedRelativeFiles(_ root: String, _ fileManager: FileManager) throws -> [String] {
        guard let enumerator = fileManager.enumerator(atPath: root) else {
            throw SnapshotError.io("cannot enumerate \(root)")
        }
        var files: [String] = []
        for case let relative as String in enumerator {
            var isDir: ObjCBool = false
            if fileManager.fileExists(atPath: root + "/" + relative, isDirectory: &isDir), !isDir.boolValue {
                files.append(relative)
            }
        }
        files.sort()
        return files
    }

    private static func clampMtime(_ path: String, to seconds: Int64, _ fileManager: FileManager) throws {
        let date = Date(timeIntervalSince1970: Double(seconds))
        do {
            try fileManager.setAttributes([.modificationDate: date], ofItemAtPath: path)
        } catch {
            throw SnapshotError.io("utimes \(path): \(error)")
        }
    }

    private static func fileSize(_ path: String) throws -> Int64 {
        guard let size = try FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber else {
            throw SnapshotError.io("cannot stat \(path)")
        }
        return size.int64Value
    }

    /// Streamed SHA-256 (the DB/archive can be many GB), hex-encoded lowercase to
    /// match `shasum -a 256` / the JS `Bun.CryptoHasher('sha256').digest('hex')`.
    private static func sha256Hex(ofFile path: String) throws -> String {
        guard let handle = FileHandle(forReadingAtPath: path) else {
            throw SnapshotError.io("cannot open \(path) for hashing")
        }
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func writeText(_ text: String, to path: String) throws {
        do {
            try text.write(toFile: path, atomically: true, encoding: .utf8)
        } catch {
            throw SnapshotError.io("write \(path): \(error)")
        }
    }

    /// The fields written into a snapshot `manifest.json` (everything except the path and the
    /// after-archiving archive size/checksum). Bundled to keep `writeManifest` within the gate.
    struct ManifestInfo {
        let tag: String
        let schemaVersion: Int64
        let createdAt: String
        let documentCount: Int
        let dbChecksum: String
        let dbSize: Int64
    }

    /// Deterministic `manifest.json` (sorted keys, pretty-printed). The in-archive
    /// manifest omits the archive checksum/size (computed after archiving); the
    /// output manifest includes them.
    private static func writeManifest(
        _ path: String, _ info: ManifestInfo, archive: (size: Int64, checksum: String)?
    ) throws {
        let tag = info.tag
        let schemaVersion = info.schemaVersion
        let createdAt = info.createdAt
        let documentCount = info.documentCount
        let dbChecksum = info.dbChecksum
        let dbSize = info.dbSize
        var object: [String: Any] = [
            "version": tag,
            "schemaVersion": schemaVersion,
            "tier": tier,
            "createdAt": createdAt,
            "documentCount": documentCount,
            "dbChecksum": dbChecksum,
            "dbSize": dbSize
        ]
        if let archive {
            object["archiveSize"] = archive.size
            object["archiveChecksum"] = archive.checksum
        }
        do {
            let data = try JSONSerialization.data(
                withJSONObject: object, options: [.sortedKeys, .prettyPrinted])
            try data.write(to: URL(fileURLWithPath: path))
        } catch {
            throw SnapshotError.io("write manifest \(path): \(error)")
        }
    }

    private static func scalarInt(_ db: Database, _ sql: String) throws -> Int {
        let rows = try db.prepare(sql).all()
        guard let row = rows.first, case .integer(let value) = row["c"] else { return 0 }
        return Int(value)
    }
}

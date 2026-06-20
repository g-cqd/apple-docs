// The SNAPSHOT determinism gate for Snapshot (the native port of
// src/commands/snapshot.js). The contract the JS determinism CI relies on: the SAME
// `--tag` over the SAME corpus produces a BYTE-IDENTICAL `.tar.zst` across two
// independent builds (so the dist/ and dist-check/ archives match). This gate proves
// the native pipeline holds that line:
//
//   • the tag-derived `snapshot_created_at` + clamped mtimes are stable,
//   • the byte-sorted member list + pinned zstd params make the archive stable,
//   • and — the real question for the ADDB port — the cloned + mutated snapshot DB
//     is itself byte-stable for the same committed generation + the same
//     truncation/meta writes (so `dbChecksum` matches across builds).
//
// It also checks the strict `--tag` allow-list (path-escape rejection) and the
// sidecar format.

import ADDB
import ADSQLModel
import Foundation
import Testing

@testable import ADWrite

@Suite("Snapshot — deterministic .tar.zst build")
struct SnapshotTests {

    /// A minimal corpus: a root + two documents (each with a prose section), written
    /// through the REAL persist so pages/documents/sections are exactly what a crawl
    /// produces. The operational + regenerable tables exist (migrated) but are empty.
    private func makeCorpus(_ directory: URL) throws -> Database {
        let db = try Database.open(
            at: directory.appendingPathComponent("corpus.adsql").path, options: DatabaseOptions())
        _ = try migrateSchema(db)
        let now = "2026-06-20T00:00:00.000Z"
        let rootId = try CrawlPersist.upsertRoot(
            db, slug: "swiftui", displayName: "SwiftUI", kind: "framework", source: "seed", now: now)
        for key in ["swiftui/view", "swiftui/text"] {
            let doc = NormalizedDoc(
                document: NormalizedDocument(
                    sourceType: "apple-docc", key: key, title: key,
                    url: "https://developer.apple.com/documentation/\(key)",
                    abstractText: "An abstract.", headings: "Overview"),
                sections: [
                    NormalizedSection(
                        sectionKind: "discussion", heading: "Discussion",
                        contentText: "Body text for \(key).", sortOrder: 0)
                ],
                relationships: [])
            try CrawlPersist.persistNormalized(
                db, rootId: rootId, path: "/documentation/\(key)", doc,
                hashes: .init(content: "ch-\(key)", rawPayload: "rh-\(key)"), now: now)
        }
        return db
    }

    private func tempDir(_ label: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adwrite-snap-\(label)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// The leading zstd frame magic (kept as a typed `let` so the comparison below
    /// stays cheap to type-check).
    private static let zstdMagic: [UInt8] = [0x28, 0xB5, 0x2F, 0xFD]

    /// `Snapshot.build` wrapper — hoists the labeled-argument call out of the test
    /// bodies so each stays under the 100ms type-check budget.
    private func build(
        _ db: Database, into outDir: URL, tag: String = "snapshot-20260620",
        dataDir: String? = nil, schemaVersion: Int64 = 42
    ) throws -> Snapshot.Result {
        try Snapshot.build(
            db, dataDir: dataDir, outDir: outDir.path, tag: tag, schemaVersion: schemaVersion)
    }

    /// `document_raw` as `documents.key → raw bytes`.
    private func documentRawByKey(_ db: Database) throws -> [String: [UInt8]] {
        let rows = try db.prepare(
            """
            SELECT d.key AS key, r.raw AS raw FROM document_raw r
            JOIN documents d ON d.id = r.document_id ORDER BY d.key
            """
        ).all()
        var byKey: [String: [UInt8]] = [:]
        for row in rows {
            guard case .text(let key) = row["key"], case .blob(let bytes) = row["raw"] else { continue }
            byKey[key] = bytes
        }
        return byKey
    }

    @Test("two builds of the same tag produce a byte-identical archive")
    func doubleBuildDeterminism() throws {
        let dir = try tempDir("det")
        defer { try? FileManager.default.removeItem(at: dir) }

        let db = try makeCorpus(dir)
        defer { db.close() }

        let first = try build(db, into: dir.appendingPathComponent("out1"))
        let second = try build(db, into: dir.appendingPathComponent("out2"))

        #expect(first.documentCount == 2)
        #expect(first.dbChecksum == second.dbChecksum, "the cloned+mutated DB must be byte-stable")
        let archivesMatch = first.archiveChecksum == second.archiveChecksum
        #expect(archivesMatch, "the .tar.zst must be byte-identical across two builds of the same tag")
        #expect(first.archiveSize == second.archiveSize)
        #expect(first.archiveSize > 0)
        #expect(FileManager.default.fileExists(atPath: first.archivePath))

        // The sidecar matches `shasum -a 256` format: "<hex>  <name>\n".
        let sidecar = try String(contentsOfFile: first.checksumSidecarPath, encoding: .utf8)
        let expectedSidecar = "\(first.archiveChecksum)  \(first.archiveName)\n"
        #expect(sidecar == expectedSidecar)
    }

    @Test("snapshot_meta is stamped with deterministic, tag-derived values")
    func metaStamped() throws {
        let dir = try tempDir("meta")
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try makeCorpus(dir)
        defer { db.close() }

        let result = try build(db, into: dir.appendingPathComponent("out"))

        // The in-archive manifest carries the deterministic createdAt.
        let manifest = try String(contentsOfFile: result.manifestPath, encoding: .utf8)
        #expect(manifest.contains("\"createdAt\" : \"2026-06-20T00:00:00.000Z\""))
        #expect(manifest.contains("\"tier\" : \"full\""))
        #expect(manifest.contains("\"documentCount\" : 2"))
    }

    /// Write `raw-json/<key>.json` files under a fresh data dir: a large
    /// compressible payload for `swiftui/view`, a tiny one for `swiftui/text`.
    private func makeRawJson(_ root: URL) throws -> (dir: String, big: String, small: String) {
        let big = String(repeating: "{\"k\":\"vvvvvvvvvvvvvvvvvvvv\"}\n", count: 200)  // compresses well
        let small = "{\"a\":1}"  // zstd would bloat it → stays plain
        let subdir = root.appendingPathComponent("raw-json/swiftui")
        try FileManager.default.createDirectory(at: subdir, withIntermediateDirectories: true)
        try big.write(to: subdir.appendingPathComponent("view.json"), atomically: true, encoding: .utf8)
        try small.write(to: subdir.appendingPathComponent("text.json"), atomically: true, encoding: .utf8)
        return (root.path, big, small)
    }

    @Test("document_raw embeds raw-json: compressible → zstd frame, tiny → plain bytes")
    func rawPayloadEmbedding() throws {
        let dir = try tempDir("raw")
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try makeCorpus(dir)
        defer { db.close() }
        let raw = try makeRawJson(dir.appendingPathComponent("data"))

        try Snapshot.embedRawPayloads(db, dataDir: raw.dir)
        let byKey = try documentRawByKey(db)
        #expect(byKey.count == 2)

        // The stored bytes are exactly what `encodeRaw` produces (ties the row to the
        // codec). The compressible payload is a zstd frame (magic 28 b5 2f fd, smaller
        // than the source); the tiny payload stays plain UTF-8.
        let view = try #require(byKey["swiftui/view"])
        let bigEncoded = Snapshot.encodeRaw(raw.big)
        let bigBytes = raw.big.utf8.count
        #expect(view == bigEncoded)
        #expect(Array(view.prefix(4)) == Self.zstdMagic)
        #expect(view.count < bigBytes)

        let text = try #require(byKey["swiftui/text"])
        let smallBytes = Array(raw.small.utf8)
        #expect(text == smallBytes)
    }

    @Test("raw-json embedding stays deterministic across two builds")
    func rawEmbeddingDeterminism() throws {
        let dir = try tempDir("rawdet")
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try makeCorpus(dir)
        defer { db.close() }
        let raw = try makeRawJson(dir.appendingPathComponent("data"))

        let first = try build(db, into: dir.appendingPathComponent("o1"), dataDir: raw.dir)
        let second = try build(db, into: dir.appendingPathComponent("o2"), dataDir: raw.dir)
        let match = first.archiveChecksum == second.archiveChecksum
        #expect(match, "raw embedding must be byte-stable")
    }

    @Test("an unsafe tag is rejected before any filesystem write")
    func invalidTagRejected() throws {
        let dir = try tempDir("tag")
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try makeCorpus(dir)
        defer { db.close() }

        #expect(throws: Snapshot.SnapshotError.self) {
            try Snapshot.build(
                db, dataDir: nil, outDir: dir.appendingPathComponent("out").path,
                tag: "../../etc/passwd", schemaVersion: 1)
        }
    }
}

// The chunks/vectors WRITER gate for IndexEmbeddings (the native port of
// src/commands/index-embeddings.js). Self-contained — no `bun`, no model bundle:
// a deterministic fake embedder stands in for the model2vec embedder (the
// embed-equivalence gate proves the real embedder separately), so this gate proves
// the WRITER PLUMBING is byte-exact and deterministic:
//
//   • every `document_chunks` row's `vec_bin` equals `Quantize.signCode(embed(text))`
//     and `vec_i8` equals `Quantize.i8Code(embed(text))` for the chunk text the
//     bit-exact `Chunker.chunkDocument` produces — i.e. the SAME bytes the JS writer
//     stores given the same embedding (signCode == quantizeTo, i8Code == quantizeI8);
//   • the per-document chunk set + `ord` order matches `Chunker.chunkDocument`;
//   • chunk 0's binary code is mirrored into `document_vectors` (the legacy anchor);
//   • `snapshot_meta` carries `embed_dims` / `embed_model`;
//   • resume (no `full`) skips already-chunked documents; a re-index is byte-stable.
//
// Inputs are written through the REAL persist (`CrawlPersist.persistNormalized`) so
// the documents + `document_sections` the chunker reads are exactly what the crawl
// writes.

import ADDB
import ADEmbed
import ADSQLModel
import ADTestKit
import Foundation
import Testing

@testable import ADWrite

@Suite("IndexEmbeddings — native chunks/vectors writer parity")
struct IndexEmbeddingsTests {

    /// A deterministic, dependency-free embedder built on ADTestKit's `SeededRNG`
    /// (the family's reproducible SplitMix64 generator): the seed is `Seed.named` of
    /// the chunk text, so the same text always yields the same f32 vector — identical
    /// on every machine and run — with mixed signs and magnitudes so both quantizers
    /// (signCode / i8Code) are exercised.
    struct StubEmbedder: ChunkEmbedder {
        let dims: Int
        func embed(_ text: String) -> [Float] {
            var rng = SeededRNG(named: "adwrite.embed:\(text)")
            return (0 ..< dims).map { _ in Float.random(in: -1 ..< 1, using: &rng) }
        }
    }

    // MARK: - fixtures

    private static let embedder = StubEmbedder(dims: 64)

    /// A doc with prose sections (one long enough to trigger the sliding window) plus
    /// a declaration section (skipped) — exercises anchor + multi-body chunks.
    private static func richDoc() -> (NormalizedDoc, [Chunker.Section]) {
        let longBody = String(repeating: "SwiftUI views compose into a hierarchy. ", count: 40)
        let sections: [Chunker.Section] = [
            .init(kind: "abstract", heading: nil, contentText: "An abstract that rides in the anchor."),
            .init(kind: "declaration", heading: nil, contentText: "func body -> some View"),
            .init(kind: "discussion", heading: "Discussion", contentText: longBody),
            .init(kind: "overview", heading: "Overview", contentText: "A short overview paragraph."),
        ]
        let doc = NormalizedDoc(
            document: NormalizedDocument(
                sourceType: "apple-docc", key: "swiftui/view", title: "View",
                url: "https://developer.apple.com/documentation/swiftui/view",
                abstractText: "A type that represents part of your app's UI.",
                headings: "Overview. Discussion. Conforming Types"),
            sections: sections.enumerated().map { index, section in
                NormalizedSection(
                    sectionKind: section.kind, heading: section.heading,
                    contentText: section.contentText, sortOrder: index)
            },
            relationships: [])
        return (doc, sections)
    }

    /// A doc whose only non-anchor section is an abstract (dropped because the
    /// abstract already rides in the anchor) — exercises the anchor-only path.
    private static func anchorOnlyDoc() -> (NormalizedDoc, [Chunker.Section]) {
        let sections: [Chunker.Section] = [
            .init(kind: "abstract", heading: nil, contentText: "Just an abstract."),
            .init(kind: "parameters", heading: "Parameters", contentText: "value: the input"),
        ]
        let doc = NormalizedDoc(
            document: NormalizedDocument(
                sourceType: "apple-docc", key: "swiftui/text", title: "Text",
                url: "https://developer.apple.com/documentation/swiftui/text",
                abstractText: "A view that displays read-only text.", headings: "Overview"),
            sections: sections.enumerated().map { index, section in
                NormalizedSection(
                    sectionKind: section.kind, heading: section.heading,
                    contentText: section.contentText, sortOrder: index)
            },
            relationships: [])
        return (doc, sections)
    }

    // MARK: - helpers

    private func openMigrated(_ directory: URL, named: String) throws -> Database {
        let db = try Database.open(
            at: directory.appendingPathComponent(named).path, options: DatabaseOptions())
        _ = try migrateSchema(db)
        return db
    }

    private func persist(_ db: Database, _ rootId: Int64, _ doc: NormalizedDoc) throws {
        try CrawlPersist.persistNormalized(
            db, rootId: rootId, path: "/documentation/\(doc.document.key)", doc,
            hashes: .init(content: "ch-\(doc.document.key)", rawPayload: "rh-\(doc.document.key)"),
            now: "2026-06-20T00:00:00.000Z")
    }

    private func documentId(_ db: Database, key: String) throws -> Int64 {
        let rows = try db.prepare("SELECT id FROM documents WHERE key = $k").all(["k": .text(key)])
        guard let row = rows.first, case .integer(let id) = row["id"] else {
            Issue.record("no documents row for key \(key)")
            return -1
        }
        return id
    }

    private func chunkRows(_ db: Database, documentId: Int64)
        throws -> [(ord: Int64, bin: [UInt8], i8: [UInt8])]
    {
        try db.prepare(
            "SELECT ord, vec_bin, vec_i8 FROM document_chunks WHERE document_id = $d ORDER BY ord"
        )
        .all(["d": .integer(documentId)])
        .map { row in
            guard case .integer(let ord) = row["ord"], case .blob(let bin) = row["vec_bin"]
            else { return (ord: Int64(-1), bin: [], i8: []) }
            let i8: [UInt8] = { if case .blob(let b) = row["vec_i8"] { return b } else { return [] } }()
            return (ord: ord, bin: bin, i8: i8)
        }
    }

    private func anchorVec(_ db: Database, documentId: Int64) throws -> [UInt8]? {
        let rows = try db.prepare("SELECT vec FROM document_vectors WHERE document_id = $d")
            .all(["d": .integer(documentId)])
        if let row = rows.first, case .blob(let bytes) = row["vec"] { return bytes }
        return nil
    }

    /// The chunker output for a fixture doc (kept out of the test body to stay under
    /// the 100ms type-check budget).
    private func expectedChunks(_ doc: NormalizedDoc, _ sections: [Chunker.Section]) -> [String] {
        Chunker.chunkDocument(
            title: doc.document.title, abstractText: doc.document.abstractText,
            headings: doc.document.headings, sections: sections)
    }

    /// `snapshot_meta` as a plain `[key: value]` map.
    private func embedMeta(_ db: Database) throws -> [String: String] {
        var map: [String: String] = [:]
        for row in try db.prepare("SELECT key, value FROM snapshot_meta").all() {
            guard case .text(let key) = row["key"], case .text(let value) = row["value"] else { continue }
            map[key] = value
        }
        return map
    }

    /// Assert every stored chunk code matches `signCode`/`i8Code` of the embedder
    /// output for the `Chunker.chunkDocument` text, and the anchor mirror is present.
    private func verify(
        _ db: Database, key: String, expectedChunks: [String]
    ) throws {
        let id = try documentId(db, key: key)
        let stored = try chunkRows(db, documentId: id)
        #expect(stored.count == expectedChunks.count, "chunk count for \(key)")
        for (ord, text) in expectedChunks.enumerated() where ord < stored.count {
            let vec = Self.embedder.embed(text)
            #expect(stored[ord].ord == Int64(ord))
            #expect(stored[ord].bin == Quantize.signCode(vec), "vec_bin chunk \(ord) of \(key)")
            #expect(stored[ord].i8 == Quantize.i8Code(vec), "vec_i8 chunk \(ord) of \(key)")
        }
        // The ord-0 anchor is mirrored into document_vectors.
        if let first = expectedChunks.first {
            #expect(try anchorVec(db, documentId: id) == Quantize.signCode(Self.embedder.embed(first)))
        }
    }

    // MARK: - tests

    @Test("stored vec_bin/vec_i8 equal signCode/i8Code of the chunk embeddings")
    func chunkCodesMatchQuantizers() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adwrite-embed-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let db = try openMigrated(dir, named: "embed.adsql")
        defer { db.close() }
        let rootId = try CrawlPersist.upsertRoot(
            db, slug: "swiftui", displayName: "SwiftUI", kind: "framework", source: "seed",
            now: "2026-06-20T00:00:00.000Z")

        let (rich, richSections) = Self.richDoc()
        let (anchor, anchorSections) = Self.anchorOnlyDoc()
        try persist(db, rootId, rich)
        try persist(db, rootId, anchor)

        let result = try IndexEmbeddings.run(db, embedder: Self.embedder)
        #expect(result.status == "ok")
        #expect(result.indexed == 2)
        #expect(result.total == 2)

        let richChunks = expectedChunks(rich, richSections)
        let anchorChunks = expectedChunks(anchor, anchorSections)
        #expect(richChunks.count > 1, "rich doc should produce body chunks")
        #expect(anchorChunks.count == 1, "anchor-only doc is just the anchor chunk")
        #expect(result.chunks == richChunks.count + anchorChunks.count)

        try verify(db, key: "swiftui/view", expectedChunks: richChunks)
        try verify(db, key: "swiftui/text", expectedChunks: anchorChunks)

        // Model meta is stamped with the first batch.
        let meta = try embedMeta(db)
        #expect(meta["embed_dims"] == "64")
        #expect(meta["embed_model"] == IndexEmbeddings.defaultModel)
    }

    @Test("resume skips already-chunked documents; re-index is byte-stable")
    func resumeAndDeterminism() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adwrite-embed-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let db = try openMigrated(dir, named: "resume.adsql")
        defer { db.close() }
        let rootId = try CrawlPersist.upsertRoot(
            db, slug: "swiftui", displayName: "SwiftUI", kind: "framework", source: "seed",
            now: "2026-06-20T00:00:00.000Z")
        try persist(db, rootId, Self.richDoc().0)

        // First build, then a resume run: nothing left to index.
        _ = try IndexEmbeddings.run(db, embedder: Self.embedder)
        let id = try documentId(db, key: "swiftui/view")
        let firstCodes = try chunkRows(db, documentId: id).map { $0.bin }

        let resume = try IndexEmbeddings.run(db, embedder: Self.embedder, full: false)
        #expect(resume.indexed == 0, "resume must skip the already-chunked document")
        #expect(resume.chunks == 0)

        // A full re-index rewrites the same bytes (determinism).
        let reindex = try IndexEmbeddings.run(db, embedder: Self.embedder, full: true)
        #expect(reindex.indexed == 1)
        let secondCodes = try chunkRows(db, documentId: id).map { $0.bin }
        #expect(firstCodes == secondCodes, "re-index must be byte-stable")
    }
}

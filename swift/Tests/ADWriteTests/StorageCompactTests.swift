// `storage compact` gate (StorageCompact — the storage-compact.js port):
// in-place zstd section compression (opportunistic: only when smaller; small
// rows stay TEXT; already-BLOB rows skipped), the contentless body-FTS
// rebuild (MATCH still works), the document_raw purge, the profile/meta
// stamps, and the prebuilt refusal.

import ADStorage
import ADTestKit
import Foundation
import Testing

@testable import ADWrite

@Suite("StorageCompact — storage compact")
struct StorageCompactTests {
    private let now = "2026-07-01T00:00:00.000Z"

    /// Long, compressible prose (well past any zstd frame overhead).
    private let longBody = String(repeating: "Compression makes repeated prose shrink dramatically. ", count: 40)

    private func seeded() throws -> MaintenanceCorpus {
        let corpus = try MaintenanceCorpus.make("compact")
        let rootId = try corpus.addRoot(slug: "swiftui", now: now)
        try corpus.addDoc(
            rootId: rootId, key: "swiftui/view", body: longBody,
            contentJson: "{\"blocks\":[\"\(String(repeating: "x", count: 600))\"]}", now: now)
        try corpus.addDoc(rootId: rootId, key: "swiftui/tiny", body: "abc", now: now)
        try IndexBody.runFull(corpus.db, now: now)
        // An embedded raw payload, so the purge leg has something to drop.
        try corpus.db.run(
            "INSERT OR REPLACE INTO document_raw(document_id, raw) VALUES ($id, $raw)",
            ["id": .integer(try corpus.docId("swiftui/view")), "raw": .text("{\"raw\":true}")])
        return corpus
    }

    @Test("compacts sections, rebuilds body FTS contentless, drops raw, stamps profile")
    func fullCompact() throws {
        let corpus = try seeded()
        defer { corpus.destroy() }

        let result = try StorageCompact.run(corpus.db, now: now)

        expectEqual(result.status, "ok")
        expectEqual(result.sectionsCompressed, 2)  // both rows re-stored (neither cell was a BLOB)
        expectEqual(result.rawDropped, 1)
        expectEqual(result.profile, "compact")

        // The long section is now a zstd BLOB that decodes back to the original;
        // the tiny one stays plain TEXT (compression would not shrink it).
        let viewId = try corpus.docId("swiftui/view")
        let longCell = try corpus.db.get(
            "SELECT content_text FROM document_sections WHERE document_id = $id",
            ["id": .integer(viewId)])?["content_text"]
        guard case .blob(let bytes)? = longCell else {
            Issue.record("expected a BLOB content_text, got \(String(describing: longCell))")
            return
        }
        let magic: [UInt8] = Array(bytes.prefix(4))
        expectEqual(magic, [0x28, 0xB5, 0x2F, 0xFD])
        let decodedLong: String? = SectionCodec.decodeText(longCell)
        expectEqual(decodedLong, longBody)
        let tinyCell = try corpus.db.get(
            "SELECT content_text FROM document_sections WHERE document_id = $id",
            ["id": .integer(try corpus.docId("swiftui/tiny"))])?["content_text"]
        guard case .text("abc")? = tinyCell else {
            Issue.record("expected tiny section to stay TEXT, got \(String(describing: tinyCell))")
            return
        }

        // Body index: recreated contentless (the JS DDL) and still matching.
        let ddl = try corpus.db.get(
            "SELECT sql FROM sqlite_master WHERE name = 'documents_body_fts'")?
            .text("sql")
        let ddlText: String = ddl ?? ""
        expectTrue(ddlText.contains("content=''"))
        expectTrue(ddlText.contains("contentless_delete=1"))
        let hit = try corpus.db.get(
            "SELECT rowid FROM documents_body_fts WHERE documents_body_fts MATCH 'dramatically'")?
            .int("rowid")
        expectEqual(hit, viewId)

        // Raw payloads gone (table retained), meta + profile stamped.
        let rawRows: Int64 = try corpus.count("SELECT COUNT(*) AS c FROM document_raw")
        expectEqual(rawRows, 0)
        let stamped = try corpus.db.get(
            "SELECT value FROM snapshot_meta WHERE key = 'sections_compressed'")?
            .text("value")
        expectEqual(stamped, "1")
        let profile = try corpus.db.get(
            "SELECT value FROM snapshot_meta WHERE key = 'storage_profile'")?
            .text("value")
        expectEqual(profile, "compact")
    }

    @Test("a second run skips rows whose cells are already BLOBs")
    func idempotent() throws {
        let corpus = try seeded()
        defer { corpus.destroy() }
        _ = try StorageCompact.run(corpus.db, now: now)
        let second = try StorageCompact.run(corpus.db, now: now)
        // swiftui/view has BLOB text + BLOB json → skipped. swiftui/tiny has
        // TEXT text + NULL json → re-stored every run (the JS `tBlob && jBlob`
        // skip is deliberately narrow).
        #expect(second.sectionsCompressed == 1)
        #expect(second.rawDropped == 0)
        let viewCell = try corpus.db.get(
            "SELECT content_text FROM document_sections WHERE document_id = $id",
            ["id": .integer(try corpus.docId("swiftui/view"))])?["content_text"]
        #expect(SectionCodec.decodeText(viewCell) == longBody)
    }

    @Test("refuses a prebuilt install unless forced")
    func prebuiltRefusal() throws {
        let corpus = try seeded()
        defer { corpus.destroy() }
        try corpus.db.run(
            "INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES ('storage_profile', 'prebuilt')")
        #expect(throws: MaintenanceError.self) {
            try StorageCompact.run(corpus.db, now: now)
        }
        let forced = try StorageCompact.run(corpus.db, force: true, now: now)
        #expect(forced.profile == "compact")
    }

    @Test("--keep-raw retains the embedded payloads")
    func keepRaw() throws {
        let corpus = try seeded()
        defer { corpus.destroy() }
        let result = try StorageCompact.run(corpus.db, keepRaw: true, now: now)
        #expect(result.rawDropped == 0)
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM document_raw") == 1)
    }
}

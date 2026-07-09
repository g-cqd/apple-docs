// Shared scratch-corpus builder for the maintenance-verb gates (storage
// gc/materialize/compact, prune, index rebuild). Seeds through the REAL
// persist (`CrawlPersist`) into a migrated SQLite corpus laid out like a data
// dir (`<dir>/apple-docs.db`), so the verbs see exactly what a crawl writes.

import ADStorage
import Foundation

@testable import ADWrite

/// One throwaway corpus: a scratch data dir + a migrated writable connection.
struct MaintenanceCorpus {
    let dir: URL
    let db: SQLiteWriteConnection

    var dataDir: String { dir.path }
    var dbPath: String { dir.appendingPathComponent("apple-docs.db").path }

    static func make(_ label: String) throws -> MaintenanceCorpus {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adwrite-\(label)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let db = try SQLiteWriteConnection(path: dir.appendingPathComponent("apple-docs.db").path)
        try migrateSchema(db)
        return MaintenanceCorpus(dir: dir, db: db)
    }

    func destroy() {
        db.close()
        try? FileManager.default.removeItem(at: dir)
    }

    /// Upsert a root, returning its id.
    func addRoot(slug: String, kind: String = "framework", sourceType: String? = nil, now: String) throws -> Int64 {
        try CrawlPersist.upsertRoot(
            db, slug: slug, displayName: slug.capitalized, kind: kind, source: "seed",
            sourceType: sourceType, now: now)
    }

    /// Persist one document (page + documents row + sections + relationships)
    /// under the converged convention (pages.path == documents.key).
    func addDoc(
        rootId: Int64, key: String, title: String? = nil, body: String,
        contentJson: String? = nil, relationships: [NormalizedRelationship] = [], now: String
    ) throws {
        let doc = NormalizedDoc(
            document: NormalizedDocument(
                sourceType: "apple-docc", key: key, title: title ?? "Title of \(key)",
                framework: key.split(separator: "/").first.map(String.init),
                url: "https://developer.apple.com/documentation/\(key)",
                abstractText: "Abstract for \(key).", headings: "Overview"),
            sections: [
                NormalizedSection(
                    sectionKind: "discussion", heading: "Discussion", contentText: body,
                    contentJson: contentJson, sortOrder: 0)
            ],
            relationships: relationships)
        try CrawlPersist.persistNormalized(
            db, rootId: rootId, path: key, doc,
            hashes: .init(content: "c-\(key)-\(now)", rawPayload: "r-\(key)-\(now)"), now: now)
    }

    /// The document id for `key` (0 when absent).
    func docId(_ key: String) throws -> Int64 {
        try db.get("SELECT id FROM documents WHERE key = $key", ["key": .text(key)])?.int("id") ?? 0
    }

    /// One-scalar COUNT helper.
    func count(_ sql: String) throws -> Int64 {
        try db.get(sql)?.int("c") ?? -1
    }
}

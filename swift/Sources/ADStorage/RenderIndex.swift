// S7 — the web build's incremental cache: the per-document render index
// (document_render_index, migrations v9) + the `web_build` sync-checkpoint row
// (sync_checkpoint, v8). These are the ONLY writes the native web build makes
// to the corpus, mirroring db.getRenderIndexEntry / upsertRenderIndexEntry /
// clearRenderIndex and get/setSyncCheckpoint('web_build'). The owning
// StorageConnection must be opened `writable: true`.

/// One document_render_index row.
public struct RenderIndexEntry: Sendable {
    public let docId: Int64
    public let sectionsDigest: String
    public let templateVersion: String
    public let htmlHash: String
    public let updatedAt: Int64
}

extension StorageConnection {
    /// `SELECT … FROM document_render_index WHERE doc_id = ?`, nil when absent
    /// (or the table is missing — a pre-v9 corpus).
    public func renderIndexEntry(docId: Int64) -> RenderIndexEntry? {
        guard conn.tableExists("document_render_index"),
            let stmt = conn.prepareUncached(
                """
                SELECT doc_id, sections_digest, template_version, html_hash, updated_at
                FROM document_render_index WHERE doc_id = ?
                """)
        else { return nil }
        stmt.bindInt64(1, docId)
        guard stmt.step() == SQLite.row else { return nil }
        return RenderIndexEntry(
            docId: stmt.int(0) ?? 0, sectionsDigest: stmt.text(1) ?? "",
            templateVersion: stmt.text(2) ?? "", htmlHash: stmt.text(3) ?? "",
            updatedAt: stmt.int(4) ?? 0)
    }

    /// `INSERT OR REPLACE INTO document_render_index …` (upsertRenderIndexEntry;
    /// updated_at = unix seconds, supplied by the caller for determinism in
    /// tests). No-op (false) when the table is missing or the write fails.
    @discardableResult
    public func upsertRenderIndexEntry(
        docId: Int64, sectionsDigest: String, templateVersion: String, htmlHash: String,
        updatedAt: Int64
    ) -> Bool {
        guard conn.tableExists("document_render_index"),
            let stmt = conn.prepareUncached(
                """
                INSERT OR REPLACE INTO document_render_index
                  (doc_id, sections_digest, template_version, html_hash, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """)
        else { return false }
        stmt.bindInt64(1, docId)
        stmt.bindText(2, sectionsDigest)
        stmt.bindText(3, templateVersion)
        stmt.bindText(4, htmlHash)
        stmt.bindInt64(5, updatedAt)
        return stmt.step() == SQLite.done
    }

    /// `DELETE FROM document_render_index` (clearRenderIndex — `--full`).
    public func clearRenderIndex() {
        guard conn.tableExists("document_render_index"),
            let stmt = conn.prepareUncached("DELETE FROM document_render_index")
        else { return }
        _ = stmt.step()
    }

    /// `getSyncCheckpoint(key)` → the raw value TEXT (JSON), nil when absent.
    public func syncCheckpoint(key: String) -> String? {
        guard conn.tableExists("sync_checkpoint"),
            let stmt = conn.prepareUncached("SELECT value FROM sync_checkpoint WHERE key = ?")
        else { return nil }
        stmt.bindText(1, key)
        return stmt.step() == SQLite.row ? stmt.text(0) : nil
    }

    /// `setSyncCheckpoint(key, value)` — INSERT OR REPLACE with the caller's
    /// ISO `updated_at` (`new Date().toISOString()` in JS).
    @discardableResult
    public func setSyncCheckpoint(key: String, valueJSON: String, updatedAt: String) -> Bool {
        guard conn.tableExists("sync_checkpoint"),
            let stmt = conn.prepareUncached(
                "INSERT OR REPLACE INTO sync_checkpoint (key, value, updated_at) VALUES (?, ?, ?)")
        else { return false }
        stmt.bindText(1, key)
        stmt.bindText(2, valueJSON)
        stmt.bindText(3, updatedAt)
        return stmt.step() == SQLite.done
    }
}

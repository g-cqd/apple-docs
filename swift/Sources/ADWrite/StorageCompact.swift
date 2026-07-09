// `storage compact` — the native port of `storageCompact`
// (src/commands/storage-compact.js): compact an install for minimum disk.
//
//   1. zstd-compress `document_sections.content_text` / `content_json` in
//      place (the section codec — opportunistic, idempotent: already-BLOB rows
//      and rows that would not shrink are left as-is).
//   2. Rebuild `documents_body_fts` as a CONTENTLESS index (drops its stored
//      body copy; `contentless_delete=1` keeps the incremental sync's
//      delete-by-rowid path working), then reindex every body.
//   3. DELETE the embedded raw payloads (`document_raw`, `--keep-raw` retains
//      them) — DELETE, not DROP, so `storage materialize raw-json` still
//      resolves and simply returns nothing.
//   4. Stamp `sections_compressed`, switch the profile to render-on-demand
//      (`compact`), VACUUM, and truncate the WAL so the freed space is
//      realized on disk immediately.
//
// Refuses a `prebuilt` install (compaction trades disk for per-read
// decompression — the opposite of the prebuilt fast path) unless forced.

public import ADStorage

/// The compact verb over a writable, migrated corpus.
public enum StorageCompact {
    /// The JS `{ status: 'ok', sectionsCompressed, rawDropped, profile }` result.
    public struct Result: Sendable, Equatable {
        public let status: String
        public let sectionsCompressed: Int
        public let rawDropped: Int
        public let profile: String
    }

    /// storage-compact.js `BODY_FTS_CONTENTLESS`, byte-verbatim.
    static let bodyFTSContentless = """
        CREATE VIRTUAL TABLE documents_body_fts USING fts5(
          body, content='', contentless_delete=1, tokenize='porter unicode61'
        )
        """

    /// The profile catalog keys + default (src/storage/profiles.js `PROFILES` /
    /// `DEFAULT_PROFILE`) — the subset the compactor needs (get/set by name).
    static let knownProfiles: Set<String> = ["compact", "balanced", "prebuilt"]
    static let defaultProfile = "balanced"

    /// Run compact. `now` stamps the body reindex; `log` receives the JS
    /// logger.info lines. Throws ``MaintenanceError`` for the JS
    /// ValidationError refusals.
    public static func run(
        _ db: SQLiteWriteConnection, force: Bool = false, keepRaw: Bool = false, now: String,
        log: ((String) -> Void)? = nil
    ) throws -> Result {
        guard try db.hasTable("document_sections") else {
            throw MaintenanceError("Nothing to compact: this install has no document_sections.")
        }
        let profileBefore = try profile(db)
        if profileBefore == "prebuilt" && !force {
            throw MaintenanceError(
                "Refusing to compact a `prebuilt` install — it would add per-read decompression on the fast path. "
                    + "Set a render-on-demand profile first (`apple-docs storage profile compact`) or pass --force.")
        }

        // 1. Compress section content in place (one deferred transaction,
        //    the JS BEGIN … COMMIT).
        log?("Compacting document_sections…")
        let compressed = try compressSections(db)

        // 2. Rebuild documents_body_fts as contentless so it stops storing a
        //    second copy of every body.
        if try db.hasTable("documents_body_fts") {
            log?("Rebuilding body index as contentless…")
            try db.run("DROP TABLE documents_body_fts")
            try db.run(bodyFTSContentless)
            _ = try IndexBody.runFull(db, now: now)
        }

        // 2b. Drop the embedded raw upstream payloads.
        var rawDropped = 0
        if !keepRaw, try db.hasTable("document_raw") {
            rawDropped = Int(try db.get("SELECT COUNT(*) AS c FROM document_raw")?.int("c") ?? 0)
            if rawDropped > 0 {
                log?("Dropping \(rawDropped) embedded raw payloads (pass --keep-raw to retain)…")
                try db.run("DELETE FROM document_raw")
            }
        }

        // 3. Record the mode, switch to render-on-demand, reclaim freed pages.
        try db.run(
            "INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES ('sections_compressed', '1')")
        if profileBefore != "compact" {
            try db.run(
                "INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES ('storage_profile', 'compact')")
        }
        log?("Reclaiming free pages (VACUUM)…")
        try db.withFileTempStore { () throws(SQLiteWriteError) in
            try db.run("VACUUM")
        }
        // VACUUM commits via the WAL; truncate it so the freed space is
        // realized on disk immediately instead of lingering as a stale -wal.
        try db.run("PRAGMA wal_checkpoint(TRUNCATE)")

        let active = try profile(db)
        log?(
            "Compact complete: \(compressed) sections compressed; \(rawDropped) raw payloads dropped; profile=\(active)."
        )
        return Result(status: "ok", sectionsCompressed: compressed, rawDropped: rawDropped, profile: active)
    }

    /// The in-place section compression loop: rows already BLOB in BOTH cells
    /// are skipped (already compacted); every other row re-stores each cell
    /// through the codec (an existing BLOB is kept, TEXT is compressed only
    /// when that shrinks it). Returns the number of rows updated.
    private static func compressSections(_ db: SQLiteWriteConnection) throws -> Int {
        let rows = try db.all("SELECT id, content_text, content_json FROM document_sections")
        var compressed = 0
        try db.deferredTransaction { () throws(SQLiteWriteError) in
            for row in rows {
                guard let id = row.int("id") else { continue }
                let textCell = row["content_text"] ?? .null
                let jsonCell = row["content_json"] ?? .null
                if isBlob(textCell) && isBlob(jsonCell) { continue }  // already compacted
                try db.run(
                    "UPDATE document_sections SET content_text = $t, content_json = $j WHERE id = $id",
                    ["t": recode(textCell), "j": recode(jsonCell), "id": .integer(id)])
                compressed += 1
            }
        }
        return compressed
    }

    /// The JS `tBlob ? row.content_text : encodeSectionContent(row.content_text)`
    /// per-cell split: keep a BLOB, encode TEXT, pass NULL through.
    private static func recode(_ cell: SQLiteValue) -> SQLiteValue {
        switch cell {
            case .blob: return cell
            case .text(let text): return SectionCodec.encode(text)
            default: return .null
        }
    }

    private static func isBlob(_ cell: SQLiteValue) -> Bool {
        if case .blob = cell { return true }
        return false
    }

    /// `getProfile(db)` (profiles.js): `snapshot_meta.storage_profile` when it
    /// names a known profile, else the default.
    static func profile(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) -> String {
        let stored = try db.get(
            "SELECT value FROM snapshot_meta WHERE key = 'storage_profile'")?
            .text("value")
        guard let stored, knownProfiles.contains(stored) else { return defaultProfile }
        return stored
    }
}

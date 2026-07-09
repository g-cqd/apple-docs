// `index rebuild` — the native port of `src/commands/index-rebuild.js`:
// rebuild the trigram / body FTS5 indexes from existing documents data
// (recovery after FTS corruption, or (re)building on a snapshot that shipped
// without them).
//
// The DDL strings are byte-verbatim from index-rebuild.js — including the
// literal whitespace, because SQLite stores CREATE statements as written and a
// JS-rebuilt vs native-rebuilt corpus should diff clean in `.schema`. They
// normalize-match the v6 migration DDL in `AppleDocsSchema+LegacyLadder.swift`
// (index-rebuild.js duplicates v6-documents-table.js the same way; the trigger
// bodies are byte-identical between the two JS files, the CREATE VIRTUAL TABLE
// statements differ only in indentation and `IF NOT EXISTS`).
//
// Not ported: the bun-side statement-cache resets (`db._prepareStatements()` /
// `db._tier = undefined`) — this connection prepares on demand.

public import ADStorage

/// The rebuild verbs over a writable, migrated corpus.
public enum IndexRebuild {
    /// `rebuildTrigram`'s `{ status: 'ok', indexed }` result.
    public struct TrigramResult: Sendable, Equatable {
        public let status: String
        public let indexed: Int
    }

    /// `rebuildBody`'s two shapes: indexBodyFull's counts, or the lite-tier /
    /// empty-corpus refusal (`{ status: 'error', message }` — a RESULT, not a
    /// throw: the JS returns it and exits 0).
    public enum BodyResult: Sendable, Equatable {
        case indexed(IndexBody.Result)
        case error(message: String)
    }

    /// index-rebuild.js `rebuildTrigram` DDL, byte-verbatim.
    static let trigramFTSCreate = """
        CREATE VIRTUAL TABLE documents_trigram USING fts5(
              title,
              tokenize='trigram case_sensitive 0'
            )
        """

    /// index-rebuild.js `rebuildBody` DDL, byte-verbatim.
    static let bodyFTSCreate = """
        CREATE VIRTUAL TABLE documents_body_fts USING fts5(
              body,
              tokenize='porter unicode61'
            )
        """

    /// index-rebuild.js `ensureTrigramTriggers` DDL, byte-verbatim (identical
    /// to the v6 migration's trigger bodies).
    static let documentsTriggers = [
        """
        CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
            INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
            VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
            INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
          END
        """,
        """
        CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
            DELETE FROM documents_fts WHERE rowid = old.id;
            DELETE FROM documents_trigram WHERE rowid = old.id;
          END
        """,
        """
        CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
            DELETE FROM documents_fts WHERE rowid = old.id;
            INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
            VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
            DELETE FROM documents_trigram WHERE rowid = old.id;
            INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
          END
        """
    ]

    /// Rebuild the trigram FTS5 index from document titles (any tier — titles
    /// are always present). Creates the table when missing, else clears it,
    /// repopulates via INSERT…SELECT, and re-creates the documents triggers
    /// when they don't already maintain the trigram index.
    public static func rebuildTrigram(
        _ db: SQLiteWriteConnection, log: ((String) -> Void)? = nil
    ) throws -> TrigramResult {
        if try !db.hasTable("documents_trigram") {
            log?("Creating documents_trigram table...")
            try db.run(trigramFTSCreate)
        } else {
            log?("Clearing existing trigram index...")
            try db.run("DELETE FROM documents_trigram")
        }

        let count = Int(try db.get("SELECT COUNT(*) as c FROM documents")?.int("c") ?? 0)
        log?("Indexing \(count) document titles...")
        try db.run("INSERT INTO documents_trigram(rowid, title) SELECT id, title FROM documents")

        try ensureTrigramTriggers(db)

        log?("Trigram index rebuilt: \(count) titles indexed.")
        return TrigramResult(status: "ok", indexed: count)
    }

    /// Rebuild the body FTS5 index from document_sections (standard tier+).
    /// Creates the table when missing, then delegates to the full body indexer.
    public static func rebuildBody(
        _ db: SQLiteWriteConnection, now: String, log: ((String) -> Void)? = nil
    ) throws -> BodyResult {
        guard try db.hasTable("document_sections") else {
            return .error(
                message: "Cannot rebuild body index: document_sections table not available (lite tier). "
                    + "Upgrade to standard tier first.")
        }
        let sectionCount = try db.get("SELECT COUNT(*) as c FROM document_sections")?.int("c") ?? 0
        guard sectionCount > 0 else {
            return .error(message: "No document sections found. Run apple-docs sync first to populate content.")
        }

        if try !db.hasTable("documents_body_fts") {
            log?("Creating documents_body_fts table...")
            try db.run(bodyFTSCreate)
        }

        return .indexed(try IndexBody.runFull(db, now: now))
    }

    /// `ensureTrigramTriggers`: when the current `documents_ai` trigger does
    /// not reference documents_trigram, drop + recreate all three documents
    /// triggers with the trigram operations included.
    private static func ensureTrigramTriggers(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        let existing = try db.get(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='documents_ai'")?
            .text("sql")
        if existing?.contains("documents_trigram") == true { return }

        try db.run("DROP TRIGGER IF EXISTS documents_ai")
        try db.run("DROP TRIGGER IF EXISTS documents_ad")
        try db.run("DROP TRIGGER IF EXISTS documents_au")
        for trigger in documentsTriggers {
            try db.run(trigger)
        }
    }
}

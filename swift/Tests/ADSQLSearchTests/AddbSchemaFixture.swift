// The FROZEN ADDB rendering of the apple-docs schema — a TEST FIXTURE for the
// ADDB read backend's search gates (denorm equivalence / WAND rank / projection).
//
// Since the storage pivot (RFC 0007 §11/§12), the production writer
// (`ADWrite.migrateSchema` / `CrawlPersist`) writes REAL SQLite; the ADDB engine
// remains only as a READ backend for existing ADDB corpora until stage 2c
// deletes it. These suites gate that read path, so they need an ADDB catalog the
// production code no longer builds — this helper freezes the final-shape DDL the
// pre-pivot `AppleDocsSchema` emitted (the JS catalog + the v28 search-denorm
// columns `title_lc/key_lc/year_num/track_lc/root_display/root_slug` that
// `ADSQLSearch.SearchQuery.denormSQL` reads), plus the old ADDB `upsertRoot`.
//
// Deliberately NOT kept in sync with ADWrite: it dies with ADSQLSearch/ADDBBackend.

import ADDB
import ADSQLModel

/// Build the frozen ADDB apple-docs catalog on `db` (the pre-pivot final shapes;
/// only the objects the search gates touch — roots/pages/documents + sections/
/// relationships/snapshot_meta + the documents FTS companions and triggers).
func migrateAddbSchema(_ db: Database) throws {
    try db.transaction { (txn) throws(DBError) in
        for statement in addbSchemaStatements {
            try txn.run(statement)
        }
    }
}

/// The old ADDB `CrawlPersist.upsertRoot` (verbatim SQL; ADDB tracks the id via
/// `lastInsertRowid` on both the insert and the conflicting-update branch).
@discardableResult
func upsertRootAddb(
    _ db: Database, slug: String, displayName: String, kind: String, source: String,
    seedPath: String? = nil, sourceType: String? = nil, now: String
) throws -> Int64 {
    var rowid: Int64 = 0
    try db.transaction { (txn) throws(DBError) in
        let result = try txn.run(
            """
            INSERT INTO roots (slug, display_name, kind, status, source, seed_path, source_type, first_seen, last_seen)
            VALUES ($slug, $display_name, $kind, 'active', $source, $seed_path, $source_type, $now, $now)
            ON CONFLICT(slug) DO UPDATE SET
              display_name = $display_name,
              kind = CASE WHEN excluded.kind != 'unknown' THEN excluded.kind ELSE roots.kind END,
              seed_path = COALESCE($seed_path, roots.seed_path),
              last_seen = $now,
              source = $source,
              source_type = COALESCE($source_type, roots.source_type)
            RETURNING id
            """,
            [
                "slug": .text(slug),
                "display_name": .text(displayName),
                "kind": .text(kind),
                "source": .text(source),
                "seed_path": seedPath.map(Value.text) ?? .null,
                "source_type": .text(sourceType ?? "apple-docc"),
                "now": .text(now)
            ])
        rowid = result.lastInsertRowid
    }
    return rowid
}

/// The frozen final-shape DDL (the pre-pivot `AppleDocsSchema` output).
private let addbSchemaStatements: [String] = [
    """
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS roots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      slug         TEXT    NOT NULL UNIQUE,
      display_name TEXT    NOT NULL,
      kind         TEXT    NOT NULL DEFAULT 'unknown',
      status       TEXT    NOT NULL DEFAULT 'active',
      source       TEXT    NOT NULL,
      page_count   INTEGER NOT NULL DEFAULT 0,
      seed_path    TEXT,
      first_seen   TEXT    NOT NULL,
      last_seen    TEXT    NOT NULL,
      source_type  TEXT    NOT NULL DEFAULT 'apple-docc'
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      root_id       INTEGER NOT NULL REFERENCES roots(id),
      path          TEXT    NOT NULL UNIQUE,
      url           TEXT    NOT NULL,
      title         TEXT,
      role          TEXT,
      role_heading  TEXT,
      abstract      TEXT,
      platforms     TEXT,
      declaration   TEXT,
      etag          TEXT,
      last_modified TEXT,
      content_hash  TEXT,
      downloaded_at TEXT,
      converted_at  TEXT,
      status        TEXT    NOT NULL DEFAULT 'active',
      source_type   TEXT    NOT NULL DEFAULT 'apple-docc',
      language      TEXT,
      is_release_notes INTEGER DEFAULT 0,
      url_depth     INTEGER DEFAULT 0,
      doc_kind      TEXT,
      source_metadata TEXT,
      min_ios       TEXT,
      min_macos     TEXT,
      min_watchos   TEXT,
      min_tvos      TEXT,
      min_visionos  TEXT,
      consecutive_404_count INTEGER NOT NULL DEFAULT 0
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_pages_root   ON pages(root_id)",
    "CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status)",
    """
    CREATE TABLE IF NOT EXISTS documents (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type      TEXT NOT NULL DEFAULT 'apple-docc',
      key              TEXT NOT NULL UNIQUE,
      title            TEXT NOT NULL,
      kind             TEXT,
      role             TEXT,
      role_heading     TEXT,
      framework        TEXT,
      url              TEXT,
      language         TEXT,
      abstract_text    TEXT,
      declaration_text TEXT,
      headings         TEXT,
      platforms_json   TEXT,
      min_ios          TEXT,
      min_macos        TEXT,
      min_watchos      TEXT,
      min_tvos         TEXT,
      min_visionos     TEXT,
      is_deprecated    INTEGER DEFAULT 0,
      is_beta          INTEGER DEFAULT 0,
      is_release_notes INTEGER DEFAULT 0,
      url_depth        INTEGER DEFAULT 0,
      source_metadata  TEXT,
      content_hash     TEXT,
      raw_payload_hash TEXT,
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT DEFAULT (datetime('now')),
      min_ios_num      INTEGER,
      min_macos_num    INTEGER,
      min_watchos_num  INTEGER,
      min_tvos_num     INTEGER,
      min_visionos_num INTEGER,
      usr              TEXT,
      title_lc         TEXT,
      key_lc           TEXT,
      year_num         INTEGER,
      track_lc         TEXT,
      root_display     TEXT,
      root_slug        TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_documents_framework ON documents(framework)",
    "CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind)",
    "CREATE INDEX IF NOT EXISTS idx_documents_key ON documents(key)",
    """
    CREATE TABLE IF NOT EXISTS document_sections (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      section_kind  TEXT NOT NULL,
      heading       TEXT,
      content_text  TEXT NOT NULL,
      content_json  TEXT,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      UNIQUE(document_id, section_kind, sort_order)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS document_relationships (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      from_key      TEXT NOT NULL,
      to_key        TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      section       TEXT,
      sort_order    INTEGER DEFAULT 0,
      UNIQUE(from_key, to_key, relation_type)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS snapshot_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
    """,
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title, abstract, declaration, headings, key,
      tokenize='porter unicode61'
    )
    """,
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_trigram USING fts5(
      title,
      content='documents',
      content_rowid='id',
      tokenize='trigram case_sensitive 0'
    )
    """,
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_body_fts USING fts5(
      body,
      tokenize='porter unicode61'
    )
    """,
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

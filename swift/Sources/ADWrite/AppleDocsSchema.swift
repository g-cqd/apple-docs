// AppleDocsSchema — the apple-docs catalog ported to native ADDB ("ADSQLv0")
// migrations. This is the foundation of the native storage writer: it reproduces,
// statement for statement, the schema the JS reference builds by replaying
// apple-docs/src/storage/migrations/v1…v27 (32 versions; the runner's index.js
// maps v15a → migrator version 16). Crawl persist + snapshot are LATER slices and
// live elsewhere; this file defines ONLY the schema (tables, columns, indexes,
// triggers, FTS virtual tables).
//
// ── Framework ────────────────────────────────────────────────────────────────
// The migrations are `ADSQLMigrate.Migration`s run by `Migrator.migrate`, which
// wraps each body + the `schema_version` cursor bump in ONE MVCC commit (so a
// crash leaves the database fully at the old or new version, never half-migrated).
// `migrateSchema(_:)` is the single entry point.
//
// ── How the 32 JS migrations map to ADSQLMigrate ──────────────────────────────
// One `Migration` per JS version, in version order, using the SAME version
// integers as the JS MIGRATIONS list (1…27, with version 16 == v15a). Because the
// SQLite reference always replays EVERY migration on a fresh DB and the parity
// gate only compares the FINAL catalog shape, the port optimizes for that final
// shape while preserving each version's net schema effect:
//
//   • ALTER TABLE ADD COLUMN — ADDB has no ALTER TABLE. Every column the JS adds
//     via ALTER is FOLDED into that table's CREATE (we own the final shape):
//       - v3  roots.seed_path                         → folded into roots CREATE
//       - v5  roots.source_type; pages.{source_type,  → folded into roots/pages
//             language,is_release_notes,url_depth,
//             doc_kind,source_metadata,min_*}
//       - v12 apple_font_files.{source,is_variable,    → folded into the v12
//             axes_json,variant,italic};                  recreate of the table
//             apple_font_families.category            → folded into families CREATE
//       - v15a documents.min_*_num                    → folded into documents CREATE
//       - v17 pages.consecutive_404_count            → folded into pages CREATE
//       - v18 sf_symbols.bitmap_only                  → folded into sf_symbols CREATE
//       - v19 sf_symbols.codepoint                    → folded into sf_symbols CREATE
//       - v24 sf_symbols.codepoint_version           → folded into sf_symbols CREATE
//       - v26 documents.usr                           → folded into documents CREATE
//       - v27 sf_symbols.render_unsupported          → folded into sf_symbols CREATE
//     No `recreateAndCopy` is needed: a fresh DB never carries pre-ALTER rows to
//     migrate, so emitting the final-shape CREATE up front is equivalent and
//     strictly simpler. (recreateAndCopy remains the tool for an EXISTING corpus;
//     this slice builds an empty catalog.)
//
//   • CREATE TABLE / INDEX / VIRTUAL TABLE / TRIGGER — ported VERBATIM (the spike
//     proved ADDB parses `INTEGER PRIMARY KEY AUTOINCREMENT`, NOT NULL, UNIQUE,
//     DEFAULT, REFERENCES, IF NOT EXISTS, FTS5 external-content, AFTER triggers).
//
//   • DROP — ported verbatim where a later version removes an object:
//       - v11 drops + rebuilds sf_symbols_fts (folded: we just create the final one)
//       - v14 rebuilds documents_trigram as external-content (we create the final one)
//       - v15 drops the refs table + its indexes  → refs is never created here
//       - v21 drops pages_fts/titles_trigram/pages_body_fts + their triggers, and
//             idx_rel_from/idx_rel_to            → those are never created here
//
//   • Data backfills (UPDATE/INSERT … SELECT) — SKIPPED. This slice is schema-only;
//     the parity gate compares catalog shape, not rows. Tables whose ONLY purpose
//     in a migration is a backfill (v7, v20) become no-op migrations so the
//     version cursor still advances 1:1 with the JS history.
//
// ── ADDB representational notes (see PARITY normalization in the test) ─────────
//   • Composite PRIMARY KEY (sf_symbols(scope,name); framework_synonyms(canonical,
//     alias)) — ADDB models a non-integer/multi-column PK as an implicit rowid +
//     an implied UNIQUE auto-index (`sqlite_autoindex_<t>_1`) with the PK columns
//     marked NOT NULL. This MATCHES SQLite's own behavior for the same DDL.
//   • Partial index — `idx_sf_symbols_codepoint` is `… WHERE codepoint IS NOT NULL`
//     in JS; ADDB rejects partial indexes (DBError.sqlUnsupported). Ported WITHOUT
//     the WHERE clause: same name/table/column/uniqueness; the partial predicate is
//     dropped (a representational difference the gate reports).
//   • Per-index COLLATE — `idx_documents_title_nocase` is `(title COLLATE NOCASE)`;
//     ADDB parses and DISCARDS the per-index collation (collation is a column
//     attribute in its model). Ported verbatim text; the stored index is on plain
//     `title` (a representational difference the gate reports).
//   • CHECK constraints (activity.id; apple_font_files.source; sf_symbols.scope) —
//     ADDB parses and discards CHECK. SQLite keeps it in the table SQL but never
//     surfaces it in `PRAGMA table_info`, so column-level parity is unaffected.

// `public import` for the two modules whose types appear in this file's PUBLIC
// signatures: `migrateSchema(_:)` takes `ADDB.Database` and returns
// `Migrator.Outcome`, and `AppleDocsSchema.migrations` is `[Migration]` (both
// from ADSQLMigrate). The manifest's InternalImportsByDefault upcoming feature
// otherwise rejects these as internal types leaking through public API.
// `ADSQLModel` stays a plain import: `Value`/`DBError` are used only inside
// function/closure bodies (the `.text(…)` bind, the `throws(DBError)` migration
// closures), never in a public or inlinable signature — a `public import` would
// be flagged unused under -warnings-as-errors.
public import ADDB
public import ADSQLMigrate
import ADSQLModel

/// The apple-docs schema as ordered ADDB migrations. Versions mirror the JS
/// `MIGRATIONS` list exactly (1…27, where version 16 is the JS `v15a`).
public enum AppleDocsSchema {
    /// The latest schema version this catalog builds to. Mirrors the JS
    /// `SCHEMA_VERSION` (the last entry of the JS MIGRATIONS list).
    public static let latestVersion = 27

    /// Every migration, ascending. The `Migrator` re-sorts, but we keep them in
    /// order for readability and to mirror the JS history one-for-one.
    public static var migrations: [Migration] { allMigrations }

    // MARK: - v2 — activity table (already created in v1; no-op for a fresh DB)

    // JS v1 already includes `activity` (the v1 union spans v1…v13), so on a fresh
    // catalog v2's CREATE TABLE IF NOT EXISTS is a pure no-op. Kept as an empty
    // migration so the version cursor advances 1:1 with the JS history.
    private static let v2 = Migration(version: 2, name: "activity table (no-op on fresh)") {
        _ throws(DBError) in
    }

    // MARK: - v3 — roots.seed_path (folded into v1; no-op)

    private static let v3 = Migration(version: 3, name: "roots.seed_path (folded)") {
        _ throws(DBError) in
    }

    // MARK: - v4 — fuzzy/title trigram + full-body FTS (legacy; dropped by v21)

    // The JS v4 creates titles_trigram + pages_body_fts and rewires the pages
    // triggers. v21 then drops ALL of that (the legacy pages FTS subsystem). The
    // net effect on a fresh catalog is their absence, so v4 is a no-op here. (The
    // pages_fts table + pages_ai/ad/au triggers from JS v1 are likewise never
    // created, since v21 removes them.)
    private static let v4 = Migration(version: 4, name: "legacy pages FTS (dropped by v21)") {
        _ throws(DBError) in
    }

    // MARK: - v5 — multi-source metadata (columns folded; synonyms table created)

    // The roots/pages ALTER columns are folded into v1. What remains is the
    // framework_synonyms lookup table (its rows are a backfill — skipped).
    private static let v5 = Migration(version: 5, name: "framework_synonyms table") {
        ctx throws(DBError) in
        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS framework_synonyms (
              canonical TEXT NOT NULL,
              alias     TEXT NOT NULL UNIQUE,
              PRIMARY KEY (canonical, alias)
            )
            """)
    }

    // MARK: - v6 — documents + sections + relationships + snapshot_meta + FTS

    // documents folds in the v15a min_*_num columns and the v26 `usr` column. The
    // legacy backfills (documents from pages, relationships from refs) are skipped.
    // documents_trigram is created in its FINAL v14 external-content shape (JS v6
    // makes it self-contained, v14 rebuilds it as content='documents'); we emit the
    // external-content form directly. idx_rel_from/idx_rel_to (JS v6) are dropped by
    // v21, so they are not created here.
    private static let v6 = Migration(version: 6, name: "documents domain + FTS") {
        ctx throws(DBError) in
        try ctx.run(
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
              usr              TEXT
            )
            """)

        try ctx.run("CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_type)")
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_documents_framework ON documents(framework)")
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind)")
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_documents_language ON documents(language)")
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_documents_key ON documents(key)")

        try ctx.run(
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
            """)
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_sections_doc ON document_sections(document_id)")
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_sections_kind ON document_sections(section_kind)")

        try ctx.run(
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
            """)
        // idx_rel_from / idx_rel_to intentionally omitted (created by JS v6, dropped
        // by v21; net absence on a fresh catalog).

        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS snapshot_meta (
              key   TEXT PRIMARY KEY,
              value TEXT
            )
            """)

        try ctx.run(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
              title, abstract, declaration, headings, key,
              tokenize='porter unicode61'
            )
            """)
        // documents_trigram — final external-content form (JS v14).
        try ctx.run(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS documents_trigram USING fts5(
              title,
              content='documents',
              content_rowid='id',
              tokenize='trigram case_sensitive 0'
            )
            """)
        try ctx.run(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS documents_body_fts USING fts5(
              body,
              tokenize='porter unicode61'
            )
            """)

        // The documents AFTER-triggers (verbatim from JS v6) keep the FTS indexes in
        // step with documents writes.
        try ctx.run(
            """
            CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
              INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
              VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
              INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
            END
            """)
        try ctx.run(
            """
            CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
              DELETE FROM documents_fts WHERE rowid = old.id;
              DELETE FROM documents_trigram WHERE rowid = old.id;
            END
            """)
        try ctx.run(
            """
            CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
              DELETE FROM documents_fts WHERE rowid = old.id;
              INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
              VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
              DELETE FROM documents_trigram WHERE rowid = old.id;
              INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
            END
            """)
    }

    // MARK: - v7 — source_type backfill (data only; no-op)

    private static let v7 = Migration(version: 7, name: "source_type backfill (data-only, skipped)") {
        _ throws(DBError) in
    }

    // MARK: - v8 — sync_checkpoint (already in v1; no-op on fresh)

    private static let v8 = Migration(version: 8, name: "sync_checkpoint (folded into v1)") {
        _ throws(DBError) in
    }

    // MARK: - v9 — document_render_index (already in v1; no-op on fresh)

    private static let v9 = Migration(version: 9, name: "document_render_index (folded into v1)") {
        _ throws(DBError) in
    }

    // MARK: - v10 — fonts/symbols tables (final shapes already in v1; no-op)

    // JS v10 creates apple_font_families/apple_font_files/sf_symbols/sf_symbols_fts/
    // sf_symbol_renders; v12 then recreates apple_font_files with the tightened
    // UNIQUE + classification columns, and v11 rebuilds sf_symbols_fts. v1 above
    // already emits every FINAL shape, so v10 is a no-op on a fresh catalog.
    private static let v10 = Migration(version: 10, name: "fonts/symbols tables (folded into v1)") {
        _ throws(DBError) in
    }

    // MARK: - v11 — sf_symbols_fts rebuild (final shape already in v1; no-op)

    private static let v11 = Migration(version: 11, name: "sf_symbols_fts rebuild (folded into v1)") {
        _ throws(DBError) in
    }

    // MARK: - v12 — fonts classification + tightened UNIQUE (folded into v1; no-op)

    private static let v12 = Migration(version: 12, name: "fonts classification (folded into v1)") {
        _ throws(DBError) in
    }

    // MARK: - v13 — case-insensitive documents title index

    // ADDB parses and discards per-index COLLATE; the stored index is on plain
    // `title`. Ported with the COLLATE NOCASE text so the intent is explicit; the
    // gate reports the dropped collation as a representational difference.
    private static let v13 = Migration(version: 13, name: "documents title nocase index") {
        ctx throws(DBError) in
        try ctx.run(
            "CREATE INDEX IF NOT EXISTS idx_documents_title_nocase ON documents(title COLLATE NOCASE)")
    }

    // MARK: - v14 — documents_trigram external-content (final shape in v6; no-op)

    private static let v14 = Migration(version: 14, name: "documents_trigram external (folded into v6)") {
        _ throws(DBError) in
    }

    // MARK: - v15 — drop legacy refs (never created here; no-op)

    private static let v15 = Migration(version: 15, name: "drop refs (never created; no-op)") {
        _ throws(DBError) in
    }

    // MARK: - v16 == JS v15a — numeric platform companion columns + indexes

    // The min_*_num COLUMNS are folded into the documents CREATE (v6). The indexes
    // on them are real catalog objects, so they are created here (matching the
    // reference's idx_documents_min_*_num). The row-by-row backfill is skipped.
    private static let v16 = Migration(version: 16, name: "documents.min_*_num indexes (v15a)") {
        ctx throws(DBError) in
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_documents_min_ios_num ON documents(min_ios_num)")
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_documents_min_macos_num ON documents(min_macos_num)")
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_documents_min_watchos_num ON documents(min_watchos_num)")
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_documents_min_tvos_num ON documents(min_tvos_num)")
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_documents_min_visionos_num ON documents(min_visionos_num)")
    }

    // MARK: - v17 — pages.consecutive_404_count (folded into v1; no-op)

    private static let v17 = Migration(version: 17, name: "pages.consecutive_404_count (folded into v1)") {
        _ throws(DBError) in
    }

    // MARK: - v18 — sf_symbols.bitmap_only (folded into v1; no-op)

    private static let v18 = Migration(version: 18, name: "sf_symbols.bitmap_only (folded into v1)") {
        _ throws(DBError) in
    }

    // MARK: - v19 — sf_symbols.codepoint + partial index

    // The codepoint COLUMN is folded into the sf_symbols CREATE (v1). The index is
    // created here. JS makes it a PARTIAL index (WHERE codepoint IS NOT NULL); ADDB
    // rejects partial indexes, so it is created WITHOUT the predicate — same
    // name/table/column; the gate reports the dropped predicate.
    private static let v19 = Migration(version: 19, name: "sf_symbols.codepoint index") {
        ctx throws(DBError) in
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_sf_symbols_codepoint ON sf_symbols(codepoint)")
    }

    // MARK: - v20 — purge catalog meta names (data only; no-op)

    private static let v20 = Migration(version: 20, name: "purge catalog meta names (data-only, skipped)") {
        _ throws(DBError) in
    }

    // MARK: - v21 — drop legacy pages FTS + redundant rel indexes (never created; no-op)

    private static let v21 = Migration(version: 21, name: "drop legacy FTS/rel indexes (never created; no-op)") {
        _ throws(DBError) in
    }

    // MARK: - v22 — document_vectors

    private static let v22 = Migration(version: 22, name: "document_vectors") { ctx throws(DBError) in
        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS document_vectors (
              document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
              vec         BLOB NOT NULL
            )
            """)
    }

    // MARK: - v23 — document_raw

    private static let v23 = Migration(version: 23, name: "document_raw") { ctx throws(DBError) in
        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS document_raw (
              document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
              raw         BLOB NOT NULL
            )
            """)
    }

    // MARK: - v24 — sf_symbols.codepoint_version (folded into v1; no-op)

    private static let v24 = Migration(version: 24, name: "sf_symbols.codepoint_version (folded into v1)") {
        _ throws(DBError) in
    }

    // MARK: - v25 — document_chunks

    private static let v25 = Migration(version: 25, name: "document_chunks") { ctx throws(DBError) in
        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS document_chunks (
              chunk_id    INTEGER PRIMARY KEY AUTOINCREMENT,
              document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
              ord         INTEGER NOT NULL,
              "text"      BLOB,
              vec_bin     BLOB NOT NULL,
              vec_i8      BLOB,
              UNIQUE(document_id, ord)
            )
            """)
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id)")
    }

    // MARK: - v26 — documents.usr (column folded into v6); index created here

    // The `usr` COLUMN is folded into the documents CREATE (v6). The index is a real
    // catalog object, created here to match the reference's idx_documents_usr.
    private static let v26 = Migration(version: 26, name: "documents.usr index") { ctx throws(DBError) in
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_documents_usr ON documents(usr)")
    }

    // MARK: - v27 — sf_symbols.render_unsupported (folded into v1; no-op)

    private static let v27 = Migration(version: 27, name: "sf_symbols.render_unsupported (folded into v1)") {
        _ throws(DBError) in
    }

    private static let allMigrations: [Migration] = [
        v1, v2, v3, v4, v5, v6, v7, v8, v9, v10,
        v11, v12, v13, v14, v15, v16, v17, v18, v19, v20,
        v21, v22, v23, v24, v25, v26, v27
    ]
}

// The v1 "initial schema" migration — the union of JS v1…v13 with every later ALTER folded into
// each table's CREATE (see the file header). Its size (the full final-shape DDL) lives in this
// extension so the AppleDocsSchema enum body stays within the size/complexity gate.
extension AppleDocsSchema {
    // MARK: - v1 — initial schema (union through v13, per the JS v1 comment)

    // Folds the v3/v5/v17 ALTERs into `roots`/`pages`, and the v15a/v26 ALTERs into
    // `documents`, so a fresh catalog lands the final column shape directly. The
    // `refs` table and the legacy `pages_fts`/`titles_trigram`/`pages_body_fts`
    // subsystem (created by JS v1/v4 then dropped by v15/v21) are intentionally
    // NOT created — the net effect after replaying the full JS history is their
    // absence, which a from-scratch port reaches by simply omitting them.
    private static let v1 = Migration(version: 1, name: "initial schema") { ctx throws(DBError) in
        // schema_meta — apple-docs' own TEXT key/value version table (distinct from
        // ADSQLMigrate's integer `schema_version` cursor). Created so the catalog
        // matches the reference; its 'schema_version' row is seeded in migrateSchema.
        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS schema_meta (
              key   TEXT PRIMARY KEY,
              value TEXT NOT NULL
            )
            """)

        // roots — with seed_path (v3) and source_type (v5) folded in.
        try ctx.run(
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
            """)

        // pages — with the v5 multi-source columns and v17 consecutive_404_count
        // folded in (final column order matches the reference table_info dump).
        try ctx.run(
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
            """)

        try ctx.run("CREATE INDEX IF NOT EXISTS idx_pages_root   ON pages(root_id)")
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_pages_role   ON pages(role)")
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_pages_title  ON pages(title)")
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status)")

        // Other v1 tables carried verbatim.
        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS crawl_state (
              path      TEXT    PRIMARY KEY,
              status    TEXT    NOT NULL DEFAULT 'pending',
              root_slug TEXT    NOT NULL,
              depth     INTEGER NOT NULL DEFAULT 0,
              error     TEXT
            )
            """)

        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS activity (
              id         INTEGER PRIMARY KEY CHECK (id = 1),
              action     TEXT    NOT NULL,
              started_at TEXT    NOT NULL,
              pid        INTEGER NOT NULL,
              roots      TEXT
            )
            """)

        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS update_log (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              timestamp   TEXT    NOT NULL,
              root_slug   TEXT,
              action      TEXT    NOT NULL,
              new_count   INTEGER NOT NULL DEFAULT 0,
              mod_count   INTEGER NOT NULL DEFAULT 0,
              del_count   INTEGER NOT NULL DEFAULT 0,
              err_count   INTEGER NOT NULL DEFAULT 0,
              duration_ms INTEGER
            )
            """)

        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS sync_checkpoint (
              key        TEXT PRIMARY KEY,
              value      TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """)

        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS document_render_index (
              doc_id           INTEGER PRIMARY KEY,
              sections_digest  TEXT    NOT NULL,
              template_version TEXT    NOT NULL,
              html_hash        TEXT    NOT NULL,
              updated_at       INTEGER NOT NULL
            )
            """)

        // apple_font_families — with the v12 `category` column folded in.
        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS apple_font_families (
              id              TEXT PRIMARY KEY,
              display_name    TEXT NOT NULL,
              source_url      TEXT,
              source_sha256   TEXT,
              source_size     INTEGER,
              source_path     TEXT,
              extracted_path  TEXT,
              status          TEXT NOT NULL DEFAULT 'available',
              category        TEXT,
              updated_at      TEXT NOT NULL
            )
            """)

        // apple_font_files — final v12 shape (the v10 table is created and then
        // recreated by v12 with UNIQUE(family_id, file_name) and the classification
        // columns; we emit the final shape directly).
        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS apple_font_files (
              id             TEXT PRIMARY KEY,
              family_id      TEXT NOT NULL REFERENCES apple_font_families(id) ON DELETE CASCADE,
              file_name      TEXT NOT NULL,
              file_path      TEXT NOT NULL,
              postscript_name TEXT,
              style_name     TEXT,
              weight         TEXT,
              variant        TEXT,
              italic         INTEGER NOT NULL DEFAULT 0,
              format         TEXT,
              source         TEXT NOT NULL DEFAULT 'remote' CHECK(source IN ('remote', 'system')),
              is_variable    INTEGER NOT NULL DEFAULT 0,
              axes_json      TEXT,
              sha256         TEXT,
              size           INTEGER,
              updated_at     TEXT NOT NULL,
              UNIQUE(family_id, file_name)
            )
            """)
        try ctx.run("CREATE INDEX IF NOT EXISTS idx_apple_font_files_family ON apple_font_files(family_id)")

        // sf_symbols — with bitmap_only (v18), codepoint (v19), codepoint_version
        // (v24), render_unsupported (v27) folded in, in that column order.
        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS sf_symbols (
              name              TEXT NOT NULL,
              scope             TEXT NOT NULL CHECK(scope IN ('public', 'private')),
              categories_json   TEXT,
              keywords_json     TEXT,
              aliases_json      TEXT,
              availability_json TEXT,
              order_index       INTEGER,
              bundle_path       TEXT,
              bundle_version    TEXT,
              updated_at        TEXT NOT NULL,
              bitmap_only       INTEGER NOT NULL DEFAULT 0,
              codepoint         INTEGER,
              codepoint_version TEXT,
              render_unsupported INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (scope, name)
            )
            """)

        // sf_symbols_fts — the FINAL shape (JS v10 creates it, v11 drops + rebuilds
        // it identically; the net shape is this one).
        try ctx.run(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS sf_symbols_fts USING fts5(
              name,
              keywords,
              categories,
              aliases,
              tokenize='porter unicode61'
            )
            """)

        try ctx.run(
            """
            CREATE TABLE IF NOT EXISTS sf_symbol_renders (
              cache_key    TEXT PRIMARY KEY,
              name         TEXT NOT NULL,
              scope        TEXT NOT NULL,
              format       TEXT NOT NULL,
              mode         TEXT,
              weight       TEXT,
              symbol_scale TEXT,
              point_size   INTEGER,
              color        TEXT,
              file_path    TEXT NOT NULL,
              mime_type    TEXT NOT NULL,
              sha256       TEXT,
              size         INTEGER,
              updated_at   TEXT NOT NULL
            )
            """)
    }
}

/// Runs the full apple-docs schema against `db`: applies every pending migration
/// in version order (via `ADSQLMigrate.Migrator`), then mirrors apple-docs'
/// `schema_meta` semantics by recording the final version under the
/// `'schema_version'` key (the JS `runMigrations` writes the same row).
///
/// Idempotent: re-running on an up-to-date catalog is a no-op. The ADSQLMigrate
/// `schema_version` integer cursor and the apple-docs `schema_meta` TEXT row are
/// kept in lockstep (both land the same final version).
///
/// - Parameter db: an open read-write ADDB `Database`.
/// - Returns: the migrator ``Migrator/Outcome`` (starting/final versions, applied list).
/// - Throws: `MigrationError` for orchestration faults, or the engine's `DBError`
///   when a migration body fails (its transaction rolls back).
@discardableResult
public func migrateSchema(_ db: Database) throws -> Migrator.Outcome {
    let migrator = try Migrator(migrations: AppleDocsSchema.migrations)
    let outcome = try migrator.migrate(db)

    // Mirror apple-docs schema_meta: the JS runner writes
    // INSERT OR REPLACE INTO schema_meta(key,value) VALUES('schema_version', <ver>).
    // schema_meta is created by the v1 migration; record the final version here so a
    // reader querying schema_meta (the apple-docs convention) sees the same value the
    // integer cursor holds.
    try db.transaction { (txn) throws(DBError) in
        try txn.run(
            """
            INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)
            """,
            .text(String(AppleDocsSchema.latestVersion)))
    }

    return outcome
}

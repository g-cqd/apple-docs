// Migration steps v2…v15 — the VERBATIM SQL of `src/storage/migrations/v2-*.js`
// … `v15-kill-refs.js`, one Swift function per JS `up(db)`. Data backfills are
// ported too (no-ops on a fresh DB, real work on an old JS-era corpus) so the
// ladder migrates BOTH cases identically to the JS runner.

import ADStorage

extension AppleDocsSchema {
    /// v2 — activity table for tracking long-running operations.
    static func v2(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run(
            """
            CREATE TABLE IF NOT EXISTS activity (
                id         INTEGER PRIMARY KEY CHECK (id = 1),
                action     TEXT    NOT NULL,
                started_at TEXT    NOT NULL,
                pid        INTEGER NOT NULL,
                roots      TEXT
              )
            """)
    }

    /// v3 — add seed_path to roots. ALTER guarded against re-run on partial DBs.
    static func v3(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        alterIgnoringFailure(db, "ALTER TABLE roots ADD COLUMN seed_path TEXT")
    }

    /// v4 — fuzzy/title trigram + full-body FTS5 tables, plus replacement triggers.
    static func v4(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.exec(v4SQL)
    }

    /// v5 — multi-source metadata columns on roots + pages, framework synonyms
    /// table, and the source-type/computed-column backfills.
    static func v5(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        alterIgnoringFailure(db, "ALTER TABLE roots ADD COLUMN source_type TEXT NOT NULL DEFAULT 'apple-docc'")
        let pageColumns = [
            "source_type TEXT NOT NULL DEFAULT 'apple-docc'", "language TEXT",
            "is_release_notes INTEGER DEFAULT 0", "url_depth INTEGER DEFAULT 0", "doc_kind TEXT",
            "source_metadata TEXT", "min_ios TEXT", "min_macos TEXT", "min_watchos TEXT",
            "min_tvos TEXT", "min_visionos TEXT"
        ]
        for column in pageColumns {
            alterIgnoringFailure(db, "ALTER TABLE pages ADD COLUMN \(column)")
        }

        try db.run(
            """
            CREATE TABLE IF NOT EXISTS framework_synonyms (
                canonical TEXT NOT NULL,
                alias     TEXT NOT NULL UNIQUE,
                PRIMARY KEY (canonical, alias)
              )
            """)
        let synonyms: [(String, String)] = [
            ("quartzcore", "coreanimation"), ("coreanimation", "quartzcore"),
            ("quartz2d", "coregraphics"), ("coregraphics", "quartz2d"), ("metalkit", "metal"),
            ("uikitcore", "uikit"), ("appkit", "cocoa"), ("metalperformanceshaders", "metal"),
            ("foundation", "nsobject"), ("swiftui", "declarativeui")
        ]
        for (canonical, alias) in synonyms {
            try db.run(
                "INSERT OR IGNORE INTO framework_synonyms (canonical, alias) VALUES ($canonical, $alias)",
                ["canonical": .text(canonical), "alias": .text(alias)])
        }

        try db.run("UPDATE roots SET source_type = 'hig' WHERE kind = 'design'")
        try db.run("UPDATE roots SET source_type = 'guidelines' WHERE slug = 'app-store-review'")
        try db.run(
            "UPDATE pages SET source_type = (SELECT r.source_type FROM roots r WHERE r.id = pages.root_id) "
                + "WHERE EXISTS (SELECT 1 FROM roots r WHERE r.id = pages.root_id AND r.source_type != 'apple-docc')"
        )
        try db.run(
            "UPDATE pages SET is_release_notes = 1 WHERE path LIKE '%/release-notes%' OR role = 'releaseNotes'")
        try db.run("UPDATE pages SET url_depth = length(path) - length(replace(path, '/', ''))")
        try db.run("UPDATE pages SET doc_kind = role WHERE role IS NOT NULL")
    }

    /// v6 — the canonical documents table + sections/relationships/snapshot_meta +
    /// the documents_* FTS5 companions, triggers, and the pages/refs backfills.
    static func v6(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.exec(v6SQL)
    }

    /// v7 — backfill source_type on roots/pages/documents from the canonical
    /// slug→source map (insertion order mirrors `ROOT_SOURCE_TYPE_BY_SLUG`).
    static func v7(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        for (slug, sourceType) in CrawlPersist.ROOT_SOURCE_TYPE_ENTRIES {
            try db.run(
                "UPDATE roots SET source_type = $source_type WHERE slug = $slug",
                ["source_type": .text(sourceType), "slug": .text(slug)])
            try db.run(
                "UPDATE pages SET source_type = $source_type "
                    + "WHERE root_id IN (SELECT id FROM roots WHERE slug = $slug)",
                ["source_type": .text(sourceType), "slug": .text(slug)])
            try db.run(
                "UPDATE documents SET source_type = $source_type WHERE key = $slug OR key LIKE $prefix",
                ["source_type": .text(sourceType), "slug": .text(slug), "prefix": .text("\(slug)/%")])
        }
    }

    /// v8 — generic sync checkpoint table for resumable long-running ops.
    static func v8(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run(
            """
            CREATE TABLE IF NOT EXISTS sync_checkpoint (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at TEXT NOT NULL
              )
            """)
    }

    /// v9 — render-index table backing the incremental web-build cache.
    static func v9(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run(
            """
            CREATE TABLE IF NOT EXISTS document_render_index (
                doc_id           INTEGER PRIMARY KEY,
                sections_digest  TEXT    NOT NULL,
                template_version TEXT    NOT NULL,
                html_hash        TEXT    NOT NULL,
                updated_at       INTEGER NOT NULL
              )
            """)
    }

    /// v10 — fonts + SF Symbols asset domain (catalog, file inventory, FTS, renders).
    static func v10(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.exec(v10SQL)
    }

    /// v11 — rebuild sf_symbols_fts from the JSON sidecar columns.
    static func v11(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.exec(
            """
            DROP TABLE IF EXISTS sf_symbols_fts;
            CREATE VIRTUAL TABLE sf_symbols_fts USING fts5(
              name,
              keywords,
              categories,
              aliases,
              tokenize='porter unicode61'
            );
            INSERT INTO sf_symbols_fts(rowid, name, keywords, categories, aliases)
            SELECT rowid, name, COALESCE(keywords_json, ''), COALESCE(categories_json, ''), COALESCE(aliases_json, '')
            FROM sf_symbols;
            """)
    }

    /// v12 — typography classification columns + tightened apple_font_files
    /// uniqueness (dedup, then a shadow-table rebuild to UNIQUE(family_id, file_name)).
    static func v12(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        alterIgnoringFailure(db, "ALTER TABLE apple_font_families ADD COLUMN category TEXT")
        let fileColumns = [
            "source TEXT NOT NULL DEFAULT 'remote'", "is_variable INTEGER NOT NULL DEFAULT 0",
            "axes_json TEXT", "variant TEXT", "italic INTEGER NOT NULL DEFAULT 0"
        ]
        for column in fileColumns {
            alterIgnoringFailure(db, "ALTER TABLE apple_font_files ADD COLUMN \(column)")
        }
        try db.run(
            """
            DELETE FROM apple_font_files
                WHERE rowid NOT IN (
                  SELECT MIN(rowid)
                  FROM apple_font_files
                  GROUP BY family_id, file_name
                  ORDER BY CASE WHEN file_path LIKE '%/.apple-docs/resources/fonts/extracted/%' THEN 0 ELSE 1 END
                )
            """)
        try db.exec(v12RebuildSQL)
    }

    /// v13 — case-insensitive documents title index.
    static func v13(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run(
            "CREATE INDEX IF NOT EXISTS idx_documents_title_nocase ON documents(title COLLATE NOCASE)")
    }

    /// v14 — switch documents_trigram to FTS5 external-content backed by documents.
    static func v14(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run("DROP TABLE IF EXISTS documents_trigram")
        try db.run(
            """
            CREATE VIRTUAL TABLE documents_trigram USING fts5(
                title,
                content='documents',
                content_rowid='id',
                tokenize='trigram case_sensitive 0'
              )
            """)
        try db.run(
            "INSERT INTO documents_trigram(rowid, title) SELECT id, title FROM documents WHERE title IS NOT NULL")
    }

    /// v15 — drop the legacy `refs` table (its indexes first, for partial DBs).
    static func v15(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run("DROP INDEX IF EXISTS idx_refs_source")
        try db.run("DROP INDEX IF EXISTS idx_refs_target")
        try db.run("DROP TABLE IF EXISTS refs")
    }
}

/// v4 (`v4-fts-trigram.js`) — trigram + body FTS and the replacement pages triggers.
private let v4SQL = """
    CREATE VIRTUAL TABLE IF NOT EXISTS titles_trigram USING fts5(
      title, content='pages', content_rowid='id',
      tokenize='trigram case_sensitive 0'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_body_fts USING fts5(
      body, tokenize='porter unicode61'
    );
    DROP TRIGGER IF EXISTS pages_ai;
    DROP TRIGGER IF EXISTS pages_ad;
    DROP TRIGGER IF EXISTS pages_au;
    CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, title, role_heading, abstract, path, declaration)
      VALUES (new.id, new.title, new.role_heading, new.abstract, new.path, new.declaration);
      INSERT INTO titles_trigram(rowid, title) VALUES (new.id, new.title);
    END;
    CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
      INSERT INTO pages_fts(pages_fts, rowid, title, role_heading, abstract, path, declaration)
      VALUES ('delete', old.id, old.title, old.role_heading, old.abstract, old.path, old.declaration);
      INSERT INTO titles_trigram(titles_trigram, rowid, title) VALUES ('delete', old.id, old.title);
    END;
    CREATE TRIGGER pages_au AFTER UPDATE ON pages BEGIN
      INSERT INTO pages_fts(pages_fts, rowid, title, role_heading, abstract, path, declaration)
      VALUES ('delete', old.id, old.title, old.role_heading, old.abstract, old.path, old.declaration);
      INSERT INTO pages_fts(rowid, title, role_heading, abstract, path, declaration)
      VALUES (new.id, new.title, new.role_heading, new.abstract, new.path, new.declaration);
      INSERT INTO titles_trigram(titles_trigram, rowid, title) VALUES ('delete', old.id, old.title);
      INSERT INTO titles_trigram(rowid, title) VALUES (new.id, new.title);
    END;
    INSERT INTO titles_trigram(rowid, title) SELECT id, title FROM pages WHERE title IS NOT NULL;
    """

/// v10 (`v10-fonts-symbols-tables.js`) — the original fonts/symbols DDL block.
private let v10SQL = """
    CREATE TABLE IF NOT EXISTS apple_font_families (
      id              TEXT PRIMARY KEY,
      display_name    TEXT NOT NULL,
      source_url      TEXT,
      source_sha256   TEXT,
      source_size     INTEGER,
      source_path     TEXT,
      extracted_path  TEXT,
      status          TEXT NOT NULL DEFAULT 'available',
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS apple_font_files (
      id              TEXT PRIMARY KEY,
      family_id       TEXT NOT NULL REFERENCES apple_font_families(id) ON DELETE CASCADE,
      file_name       TEXT NOT NULL,
      file_path       TEXT NOT NULL,
      postscript_name TEXT,
      style_name      TEXT,
      weight          TEXT,
      format          TEXT,
      sha256          TEXT,
      size            INTEGER,
      updated_at      TEXT NOT NULL,
      UNIQUE(family_id, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_apple_font_files_family ON apple_font_files(family_id);

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
      PRIMARY KEY (scope, name)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS sf_symbols_fts USING fts5(
      name,
      keywords,
      categories,
      aliases,
      tokenize='porter unicode61'
    );

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
    );
    """

/// v12 (`v12-fonts-classification.js`) — the shadow-table rebuild to the tightened
/// UNIQUE(family_id, file_name) constraint.
private let v12RebuildSQL = """
    CREATE TABLE apple_font_files_v12 (
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
    );
    INSERT INTO apple_font_files_v12 (
      id, family_id, file_name, file_path, postscript_name, style_name,
      weight, variant, italic, format, source, is_variable, axes_json,
      sha256, size, updated_at
    )
    SELECT
      id, family_id, file_name, file_path, postscript_name, style_name,
      weight, variant, COALESCE(italic, 0), format,
      COALESCE(source, 'remote'), COALESCE(is_variable, 0), axes_json,
      sha256, size, updated_at
    FROM apple_font_files;
    DROP TABLE apple_font_files;
    ALTER TABLE apple_font_files_v12 RENAME TO apple_font_files;
    CREATE INDEX IF NOT EXISTS idx_apple_font_files_family ON apple_font_files(family_id);
    """

/// v6 (`v6-documents-table.js`) — the documents domain: tables, indexes, FTS,
/// triggers, and the pages/refs backfills, statement-for-statement.
private let v6SQL = """
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
      updated_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_type);
    CREATE INDEX IF NOT EXISTS idx_documents_framework ON documents(framework);
    CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind);
    CREATE INDEX IF NOT EXISTS idx_documents_language ON documents(language);
    CREATE INDEX IF NOT EXISTS idx_documents_key ON documents(key);

    CREATE TABLE IF NOT EXISTS document_sections (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      section_kind  TEXT NOT NULL,
      heading       TEXT,
      content_text  TEXT NOT NULL,
      content_json  TEXT,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      UNIQUE(document_id, section_kind, sort_order)
    );
    CREATE INDEX IF NOT EXISTS idx_sections_doc ON document_sections(document_id);
    CREATE INDEX IF NOT EXISTS idx_sections_kind ON document_sections(section_kind);

    CREATE TABLE IF NOT EXISTS document_relationships (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      from_key      TEXT NOT NULL,
      to_key        TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      section       TEXT,
      sort_order    INTEGER DEFAULT 0,
      UNIQUE(from_key, to_key, relation_type)
    );
    CREATE INDEX IF NOT EXISTS idx_rel_from ON document_relationships(from_key);
    CREATE INDEX IF NOT EXISTS idx_rel_to ON document_relationships(to_key);

    CREATE TABLE IF NOT EXISTS snapshot_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title, abstract, declaration, headings, key,
      tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_trigram USING fts5(
      title,
      tokenize='trigram case_sensitive 0'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_body_fts USING fts5(
      body,
      tokenize='porter unicode61'
    );

    DROP TRIGGER IF EXISTS documents_ai;
    DROP TRIGGER IF EXISTS documents_ad;
    DROP TRIGGER IF EXISTS documents_au;
    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
      VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
      INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
    END;
    CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid = old.id;
      DELETE FROM documents_trigram WHERE rowid = old.id;
    END;
    CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid = old.id;
      INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
      VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
      DELETE FROM documents_trigram WHERE rowid = old.id;
      INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
    END;

    INSERT OR IGNORE INTO documents (
      source_type, key, title, kind, role, role_heading, framework, url, language,
      abstract_text, declaration_text, platforms_json,
      min_ios, min_macos, min_watchos, min_tvos, min_visionos,
      is_release_notes, url_depth, source_metadata, content_hash, raw_payload_hash
    )
    SELECT
      COALESCE(p.source_type, r.source_type, 'apple-docc'),
      p.path,
      COALESCE(p.title, p.path),
      COALESCE(p.doc_kind, p.role),
      p.role,
      p.role_heading,
      COALESCE(r.slug, CASE
        WHEN instr(p.path, '/') > 0 THEN substr(p.path, 1, instr(p.path, '/') - 1)
        ELSE p.path
      END),
      p.url,
      p.language,
      p.abstract,
      p.declaration,
      p.platforms,
      p.min_ios,
      p.min_macos,
      p.min_watchos,
      p.min_tvos,
      p.min_visionos,
      COALESCE(p.is_release_notes, 0),
      COALESCE(p.url_depth, 0),
      p.source_metadata,
      p.content_hash,
      p.content_hash
    FROM pages p
    LEFT JOIN roots r ON r.id = p.root_id;

    INSERT OR IGNORE INTO document_relationships (from_key, to_key, relation_type, section, sort_order)
    SELECT p.path, refs.target_path, 'reference', refs.section, 0
    FROM refs
    JOIN pages p ON p.id = refs.source_id;
    """

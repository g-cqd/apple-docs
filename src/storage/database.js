import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_VERSION = 6

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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
  last_seen    TEXT    NOT NULL
);

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
  status        TEXT    NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_pages_root   ON pages(root_id);
CREATE INDEX IF NOT EXISTS idx_pages_role   ON pages(role);
CREATE INDEX IF NOT EXISTS idx_pages_title  ON pages(title);
CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  role_heading,
  abstract,
  path,
  declaration,
  content='pages',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, role_heading, abstract, path, declaration)
  VALUES (new.id, new.title, new.role_heading, new.abstract, new.path, new.declaration);
END;

CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, role_heading, abstract, path, declaration)
  VALUES ('delete', old.id, old.title, old.role_heading, old.abstract, old.path, old.declaration);
END;

CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, role_heading, abstract, path, declaration)
  VALUES ('delete', old.id, old.title, old.role_heading, old.abstract, old.path, old.declaration);
  INSERT INTO pages_fts(rowid, title, role_heading, abstract, path, declaration)
  VALUES (new.id, new.title, new.role_heading, new.abstract, new.path, new.declaration);
END;

CREATE TABLE IF NOT EXISTS refs (
  source_id   INTEGER NOT NULL REFERENCES pages(id),
  target_path TEXT    NOT NULL,
  anchor_text TEXT,
  section     TEXT
);

CREATE INDEX IF NOT EXISTS idx_refs_source ON refs(source_id);
CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_path);

CREATE TABLE IF NOT EXISTS crawl_state (
  path      TEXT    PRIMARY KEY,
  status    TEXT    NOT NULL DEFAULT 'pending',
  root_slug TEXT    NOT NULL,
  depth     INTEGER NOT NULL DEFAULT 0,
  error     TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  action     TEXT    NOT NULL,
  started_at TEXT    NOT NULL,
  pid        INTEGER NOT NULL,
  roots      TEXT
);

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
);
`

function serializePlatforms(value) {
  if (value == null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function deriveFrameworkFromPath(path) {
  if (!path) return null
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'documentation') return parts[1] ?? null
  return parts[0] ?? null
}

function deriveRootSourceType(slug, kind) {
  if (slug === 'app-store-review' || kind === 'guidelines') return 'guidelines'
  if (slug === 'design' || kind === 'design') return 'hig'
  return 'apple-docc'
}

export class DocsDatabase {
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('PRAGMA synchronous = NORMAL')
    this.db.run('PRAGMA cache_size = -64000')
    this.db.run('PRAGMA temp_store = MEMORY')
    this.db.run('PRAGMA busy_timeout = 5000')
    this._migrate()
    this._prepareStatements()
  }

  _migrate() {
    // Check existing version before starting
    this.db.run('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = this.db.query('SELECT value FROM schema_meta WHERE key = ?').get('schema_version')
    const current = row ? parseInt(row.value, 10) : 0

    // Refuse to open a database from a newer version (downgrade protection)
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${current} is newer than supported version ${SCHEMA_VERSION}. ` +
        `Update apple-docs to a newer version.`
      )
    }

    // Nothing to do if already current
    if (current === SCHEMA_VERSION) return

    // Run migrations in a transaction
    this.db.run('BEGIN')
    try {
      if (current < 1) {
        this.db.exec(SCHEMA_SQL)
      }
      if (current < 2) {
        this.db.run(`CREATE TABLE IF NOT EXISTS activity (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          action     TEXT    NOT NULL,
          started_at TEXT    NOT NULL,
          pid        INTEGER NOT NULL,
          roots      TEXT
        )`)
      }
      if (current < 3) {
        try { this.db.run('ALTER TABLE roots ADD COLUMN seed_path TEXT') } catch {}
      }
      if (current < 4) {
        // Trigram FTS5 table for fuzzy title matching
        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS titles_trigram USING fts5(
          title, content='pages', content_rowid='id',
          tokenize='trigram case_sensitive 0'
        )`)
        // Full-body FTS5 table (opt-in, populated by index command)
        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS pages_body_fts USING fts5(
          body, tokenize='porter unicode61'
        )`)
        // Replace triggers to also sync titles_trigram
        this.db.run('DROP TRIGGER IF EXISTS pages_ai')
        this.db.run('DROP TRIGGER IF EXISTS pages_ad')
        this.db.run('DROP TRIGGER IF EXISTS pages_au')
        this.db.run(`CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
          INSERT INTO pages_fts(rowid, title, role_heading, abstract, path, declaration)
          VALUES (new.id, new.title, new.role_heading, new.abstract, new.path, new.declaration);
          INSERT INTO titles_trigram(rowid, title) VALUES (new.id, new.title);
        END`)
        this.db.run(`CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
          INSERT INTO pages_fts(pages_fts, rowid, title, role_heading, abstract, path, declaration)
          VALUES ('delete', old.id, old.title, old.role_heading, old.abstract, old.path, old.declaration);
          INSERT INTO titles_trigram(titles_trigram, rowid, title) VALUES ('delete', old.id, old.title);
        END`)
        this.db.run(`CREATE TRIGGER pages_au AFTER UPDATE ON pages BEGIN
          INSERT INTO pages_fts(pages_fts, rowid, title, role_heading, abstract, path, declaration)
          VALUES ('delete', old.id, old.title, old.role_heading, old.abstract, old.path, old.declaration);
          INSERT INTO pages_fts(rowid, title, role_heading, abstract, path, declaration)
          VALUES (new.id, new.title, new.role_heading, new.abstract, new.path, new.declaration);
          INSERT INTO titles_trigram(titles_trigram, rowid, title) VALUES ('delete', old.id, old.title);
          INSERT INTO titles_trigram(rowid, title) VALUES (new.id, new.title);
        END`)
        // Backfill trigram table from existing pages
        this.db.run('INSERT INTO titles_trigram(rowid, title) SELECT id, title FROM pages WHERE title IS NOT NULL')
      }
      if (current < 5) {
        // Multi-source metadata columns on roots
        try { this.db.run("ALTER TABLE roots ADD COLUMN source_type TEXT NOT NULL DEFAULT 'apple-docc'") } catch {}

        // Multi-source metadata columns on pages
        try { this.db.run("ALTER TABLE pages ADD COLUMN source_type TEXT NOT NULL DEFAULT 'apple-docc'") } catch {}
        try { this.db.run('ALTER TABLE pages ADD COLUMN language TEXT') } catch {}
        try { this.db.run('ALTER TABLE pages ADD COLUMN is_release_notes INTEGER DEFAULT 0') } catch {}
        try { this.db.run('ALTER TABLE pages ADD COLUMN url_depth INTEGER DEFAULT 0') } catch {}
        try { this.db.run('ALTER TABLE pages ADD COLUMN doc_kind TEXT') } catch {}
        try { this.db.run('ALTER TABLE pages ADD COLUMN source_metadata TEXT') } catch {}
        try { this.db.run('ALTER TABLE pages ADD COLUMN min_ios TEXT') } catch {}
        try { this.db.run('ALTER TABLE pages ADD COLUMN min_macos TEXT') } catch {}
        try { this.db.run('ALTER TABLE pages ADD COLUMN min_watchos TEXT') } catch {}
        try { this.db.run('ALTER TABLE pages ADD COLUMN min_tvos TEXT') } catch {}
        try { this.db.run('ALTER TABLE pages ADD COLUMN min_visionos TEXT') } catch {}

        // Framework synonyms lookup table
        this.db.run(`CREATE TABLE IF NOT EXISTS framework_synonyms (
          canonical TEXT NOT NULL,
          alias     TEXT NOT NULL UNIQUE,
          PRIMARY KEY (canonical, alias)
        )`)
        const synonyms = [
          ['quartzcore', 'coreanimation'],
          ['coreanimation', 'quartzcore'],
          ['quartz2d', 'coregraphics'],
          ['coregraphics', 'quartz2d'],
          ['metalkit', 'metal'],
          ['uikitcore', 'uikit'],
          ['appkit', 'cocoa'],
        ]
        const insertSynonym = this.db.query('INSERT OR IGNORE INTO framework_synonyms (canonical, alias) VALUES (?, ?)')
        for (const [canonical, alias] of synonyms) {
          insertSynonym.run(canonical, alias)
        }

        // Backfill source_type from root kind
        this.db.run("UPDATE roots SET source_type = 'hig' WHERE kind = 'design'")
        this.db.run("UPDATE roots SET source_type = 'guidelines' WHERE slug = 'app-store-review'")
        this.db.run('UPDATE pages SET source_type = (SELECT r.source_type FROM roots r WHERE r.id = pages.root_id) WHERE EXISTS (SELECT 1 FROM roots r WHERE r.id = pages.root_id AND r.source_type != \'apple-docc\')')

        // Backfill computed columns
        this.db.run("UPDATE pages SET is_release_notes = 1 WHERE path LIKE '%/release-notes%' OR role = 'releaseNotes'")
        this.db.run("UPDATE pages SET url_depth = length(path) - length(replace(path, '/', ''))")
        this.db.run('UPDATE pages SET doc_kind = role WHERE role IS NOT NULL')
      }
      if (current < 6) {
        this.db.run(`CREATE TABLE IF NOT EXISTS documents (
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
        )`)

        this.db.run('CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_type)')
        this.db.run('CREATE INDEX IF NOT EXISTS idx_documents_framework ON documents(framework)')
        this.db.run('CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind)')
        this.db.run('CREATE INDEX IF NOT EXISTS idx_documents_language ON documents(language)')
        this.db.run('CREATE INDEX IF NOT EXISTS idx_documents_key ON documents(key)')

        this.db.run(`CREATE TABLE IF NOT EXISTS document_sections (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          section_kind  TEXT NOT NULL,
          heading       TEXT,
          content_text  TEXT NOT NULL,
          content_json  TEXT,
          sort_order    INTEGER NOT NULL DEFAULT 0,
          UNIQUE(document_id, section_kind, sort_order)
        )`)
        this.db.run('CREATE INDEX IF NOT EXISTS idx_sections_doc ON document_sections(document_id)')
        this.db.run('CREATE INDEX IF NOT EXISTS idx_sections_kind ON document_sections(section_kind)')

        this.db.run(`CREATE TABLE IF NOT EXISTS document_relationships (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          from_key      TEXT NOT NULL,
          to_key        TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          section       TEXT,
          sort_order    INTEGER DEFAULT 0,
          UNIQUE(from_key, to_key, relation_type)
        )`)
        this.db.run('CREATE INDEX IF NOT EXISTS idx_rel_from ON document_relationships(from_key)')
        this.db.run('CREATE INDEX IF NOT EXISTS idx_rel_to ON document_relationships(to_key)')

        this.db.run(`CREATE TABLE IF NOT EXISTS snapshot_meta (
          key   TEXT PRIMARY KEY,
          value TEXT
        )`)

        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
          title, abstract, declaration, headings, key,
          tokenize='porter unicode61'
        )`)
        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_trigram USING fts5(
          title,
          tokenize='trigram case_sensitive 0'
        )`)
        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_body_fts USING fts5(
          body,
          tokenize='porter unicode61'
        )`)

        this.db.run('DROP TRIGGER IF EXISTS documents_ai')
        this.db.run('DROP TRIGGER IF EXISTS documents_ad')
        this.db.run('DROP TRIGGER IF EXISTS documents_au')
        this.db.run(`CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
          INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
          VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
          INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
        END`)
        this.db.run(`CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
          DELETE FROM documents_fts WHERE rowid = old.id;
          DELETE FROM documents_trigram WHERE rowid = old.id;
        END`)
        this.db.run(`CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
          DELETE FROM documents_fts WHERE rowid = old.id;
          INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
          VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
          DELETE FROM documents_trigram WHERE rowid = old.id;
          INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
        END`)

        this.db.run(`
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
          LEFT JOIN roots r ON r.id = p.root_id
        `)

        this.db.run(`
          INSERT OR IGNORE INTO document_relationships (from_key, to_key, relation_type, section, sort_order)
          SELECT p.path, refs.target_path, 'reference', refs.section, 0
          FROM refs
          JOIN pages p ON p.id = refs.source_id
        `)
      }
      this.db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)])
      this.db.run('COMMIT')
    } catch (e) {
      this.db.run('ROLLBACK')
      throw new Error(`Migration from v${current} to v${SCHEMA_VERSION} failed: ${e.message}`)
    }
  }

  _prepareStatements() {
    this._upsertRoot = this.db.query(`
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
    `)

    this._upsertPage = this.db.query(`
      INSERT INTO pages (
        root_id, path, url, title, role, role_heading, abstract, platforms, declaration,
        etag, last_modified, content_hash, downloaded_at, status,
        source_type, language, is_release_notes, url_depth, doc_kind, source_metadata,
        min_ios, min_macos, min_watchos, min_tvos, min_visionos
      )
      VALUES (
        $root_id, $path, $url, $title, $role, $role_heading, $abstract, $platforms, $declaration,
        $etag, $last_modified, $content_hash, $downloaded_at, 'active',
        $source_type, $language, $is_release_notes, $url_depth, $doc_kind, $source_metadata,
        $min_ios, $min_macos, $min_watchos, $min_tvos, $min_visionos
      )
      ON CONFLICT(path) DO UPDATE SET
        title = COALESCE($title, pages.title),
        role = COALESCE($role, pages.role),
        role_heading = COALESCE($role_heading, pages.role_heading),
        abstract = COALESCE($abstract, pages.abstract),
        platforms = COALESCE($platforms, pages.platforms),
        declaration = COALESCE($declaration, pages.declaration),
        etag = COALESCE($etag, pages.etag),
        last_modified = COALESCE($last_modified, pages.last_modified),
        content_hash = COALESCE($content_hash, pages.content_hash),
        downloaded_at = COALESCE($downloaded_at, pages.downloaded_at),
        source_type = COALESCE($source_type, pages.source_type),
        language = COALESCE($language, pages.language),
        is_release_notes = COALESCE($is_release_notes, pages.is_release_notes),
        url_depth = COALESCE($url_depth, pages.url_depth),
        doc_kind = COALESCE($doc_kind, pages.doc_kind),
        source_metadata = COALESCE($source_metadata, pages.source_metadata),
        min_ios = COALESCE($min_ios, pages.min_ios),
        min_macos = COALESCE($min_macos, pages.min_macos),
        min_watchos = COALESCE($min_watchos, pages.min_watchos),
        min_tvos = COALESCE($min_tvos, pages.min_tvos),
        min_visionos = COALESCE($min_visionos, pages.min_visionos),
        status = 'active'
      RETURNING id
    `)

    this._getPage = this.db.query('SELECT p.*, r.slug as root_slug, r.display_name as framework FROM pages p JOIN roots r ON p.root_id = r.id WHERE p.path = ? AND p.status = ?')

    this._getPagesByRoot = this.db.query(`
      SELECT p.path, p.title, p.role, p.role_heading, p.abstract
      FROM pages p JOIN roots r ON p.root_id = r.id
      WHERE r.slug = ? AND p.status = 'active'
      ORDER BY p.path
    `)
    this._getDocumentsByRoot = this.db.query(`
      SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract
      FROM documents d
      WHERE d.framework = ?
      ORDER BY d.key
    `)

    this._searchPages = this.db.query(`
      SELECT p.path, p.title, p.role, p.role_heading, p.abstract,
             p.declaration, p.platforms, r.display_name as framework, r.slug as root_slug,
             COALESCE(p.source_type, r.source_type) as source_type,
             p.source_metadata as source_metadata,
             bm25(pages_fts, 10.0, 5.0, 3.0, 2.0, 1.0) as rank,
             CASE
               WHEN LOWER(p.title) = LOWER($raw) THEN 0
               WHEN LOWER(p.title) LIKE LOWER($raw) || '%' THEN 1
               WHEN INSTR(LOWER(p.title), LOWER($raw)) > 0 THEN 2
               ELSE 3
             END as tier
      FROM pages_fts
      JOIN pages p ON pages_fts.rowid = p.id
      JOIN roots r ON p.root_id = r.id
      WHERE pages_fts MATCH $query
        AND ($framework IS NULL OR r.slug = $framework)
        AND ($kind IS NULL OR p.role = $kind)
        AND p.status = 'active'
      ORDER BY tier, rank
      LIMIT $limit
    `)

    // Trigram substring search on titles
    this._searchTrigram = this.db.query(`
      SELECT p.path, p.title, p.role, p.role_heading, p.abstract,
             p.declaration, p.platforms, r.display_name as framework, r.slug as root_slug,
             COALESCE(p.source_type, r.source_type) as source_type,
             p.source_metadata as source_metadata
      FROM titles_trigram
      JOIN pages p ON titles_trigram.rowid = p.id
      JOIN roots r ON p.root_id = r.id
      WHERE titles_trigram MATCH $query
        AND ($framework IS NULL OR r.slug = $framework)
        AND ($kind IS NULL OR p.role = $kind)
        AND p.status = 'active'
      LIMIT $limit
    `)

    // Full-body search
    this._searchBody = this.db.query(`
      SELECT p.path, p.title, p.role, p.role_heading, p.abstract,
             p.declaration, p.platforms, r.display_name as framework, r.slug as root_slug,
             COALESCE(p.source_type, r.source_type) as source_type,
             p.source_metadata as source_metadata,
             bm25(pages_body_fts, 1.0) as rank
      FROM pages_body_fts
      JOIN pages p ON pages_body_fts.rowid = p.id
      JOIN roots r ON p.root_id = r.id
      WHERE pages_body_fts MATCH $query
        AND ($framework IS NULL OR r.slug = $framework)
        AND ($kind IS NULL OR p.role = $kind)
        AND p.status = 'active'
      ORDER BY rank
      LIMIT $limit
    `)

    this._bodyIndexCount = this.db.query('SELECT COUNT(*) as c FROM pages_body_fts')
    this._insertBody = this.db.query('INSERT OR REPLACE INTO pages_body_fts(rowid, body) VALUES ($id, $body)')
    this._clearBody = this.db.query("DELETE FROM pages_body_fts")

    // Trigram candidates for fuzzy (returns id + title for JS-side Levenshtein)
    this._trigramCandidates = this.db.query(`
      SELECT p.id, p.title FROM titles_trigram
      JOIN pages p ON titles_trigram.rowid = p.id
      WHERE titles_trigram MATCH $trigram AND p.status = 'active'
    `)

    this._searchByTitle = this.db.query(`
      SELECT p.*, r.slug as root_slug, r.display_name as framework
      FROM pages p JOIN roots r ON p.root_id = r.id
      WHERE p.title = $title AND p.status = 'active'
        AND ($framework IS NULL OR r.slug = $framework)
      ORDER BY CASE WHEN p.role = 'symbol' THEN 0 ELSE 1 END, length(p.path)
      LIMIT 1
    `)
    this._getPagesByRole = this.db.query(`
      SELECT p.path as key, p.path, p.title, p.role,
             r.slug as root_slug, COALESCE(p.source_type, r.source_type) as source_type
      FROM pages p
      JOIN roots r ON p.root_id = r.id
      WHERE p.role = ?
        AND p.status = 'active'
      ORDER BY p.path
    `)

    this._getRoots = this.db.query('SELECT * FROM roots ORDER BY slug')
    this._getRootsByKind = this.db.query('SELECT * FROM roots WHERE kind = ? ORDER BY slug')
    this._getRootBySlug = this.db.query('SELECT * FROM roots WHERE slug = ?')
    this._getRootById = this.db.query('SELECT * FROM roots WHERE id = ?')

    this._normalizedDocumentCount = this.db.query('SELECT COUNT(*) as count FROM documents')
    this._upsertDocument = this.db.query(`
      INSERT INTO documents (
        source_type, key, title, kind, role, role_heading, framework, url, language,
        abstract_text, declaration_text, headings, platforms_json,
        min_ios, min_macos, min_watchos, min_tvos, min_visionos,
        is_deprecated, is_beta, is_release_notes, url_depth,
        source_metadata, content_hash, raw_payload_hash, created_at, updated_at
      )
      VALUES (
        $source_type, $key, $title, $kind, $role, $role_heading, $framework, $url, $language,
        $abstract_text, $declaration_text, $headings, $platforms_json,
        $min_ios, $min_macos, $min_watchos, $min_tvos, $min_visionos,
        $is_deprecated, $is_beta, $is_release_notes, $url_depth,
        $source_metadata, $content_hash, $raw_payload_hash, $now, $now
      )
      ON CONFLICT(key) DO UPDATE SET
        source_type = COALESCE($source_type, documents.source_type),
        title = COALESCE($title, documents.title),
        kind = COALESCE($kind, documents.kind),
        role = COALESCE($role, documents.role),
        role_heading = COALESCE($role_heading, documents.role_heading),
        framework = COALESCE($framework, documents.framework),
        url = COALESCE($url, documents.url),
        language = COALESCE($language, documents.language),
        abstract_text = COALESCE($abstract_text, documents.abstract_text),
        declaration_text = COALESCE($declaration_text, documents.declaration_text),
        headings = COALESCE($headings, documents.headings),
        platforms_json = COALESCE($platforms_json, documents.platforms_json),
        min_ios = COALESCE($min_ios, documents.min_ios),
        min_macos = COALESCE($min_macos, documents.min_macos),
        min_watchos = COALESCE($min_watchos, documents.min_watchos),
        min_tvos = COALESCE($min_tvos, documents.min_tvos),
        min_visionos = COALESCE($min_visionos, documents.min_visionos),
        is_deprecated = COALESCE($is_deprecated, documents.is_deprecated),
        is_beta = COALESCE($is_beta, documents.is_beta),
        is_release_notes = COALESCE($is_release_notes, documents.is_release_notes),
        url_depth = COALESCE($url_depth, documents.url_depth),
        source_metadata = COALESCE($source_metadata, documents.source_metadata),
        content_hash = COALESCE($content_hash, documents.content_hash),
        raw_payload_hash = COALESCE($raw_payload_hash, documents.raw_payload_hash),
        updated_at = $now
      RETURNING id
    `)
    this._getDocument = this.db.query(`
      SELECT d.*, COALESCE(r.slug, d.framework) as root_slug, COALESCE(r.display_name, d.framework) as framework_display
      FROM documents d
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE d.key = ?
    `)
    this._getDocumentSections = this.db.query(`
      SELECT section_kind, heading, content_text, content_json, sort_order
      FROM document_sections
      WHERE document_id = ?
      ORDER BY sort_order, id
    `)
    this._getDocumentIdByKey = this.db.query('SELECT id FROM documents WHERE key = ?')
    this._getDocumentRelationshipsBySource = this.db.query(`
      SELECT dr.to_key as target_path,
             COALESCE(td.title, dr.to_key) as anchor_text,
             COALESCE(dr.section, dr.relation_type) as section
      FROM document_relationships dr
      LEFT JOIN documents td ON td.key = dr.to_key
      WHERE dr.from_key = ?
      ORDER BY dr.sort_order, dr.to_key
    `)
    this._deleteDocumentSections = this.db.query('DELETE FROM document_sections WHERE document_id = ?')
    this._insertDocumentSection = this.db.query(`
      INSERT INTO document_sections (document_id, section_kind, heading, content_text, content_json, sort_order)
      VALUES ($document_id, $section_kind, $heading, $content_text, $content_json, $sort_order)
      ON CONFLICT(document_id, section_kind, sort_order) DO UPDATE SET
        heading = $heading,
        content_text = $content_text,
        content_json = $content_json
    `)
    this._deleteDocumentRelationships = this.db.query('DELETE FROM document_relationships WHERE from_key = ?')
    this._deleteDocumentRelationshipsByKey = this.db.query('DELETE FROM document_relationships WHERE from_key = ? OR to_key = ?')
    this._insertDocumentRelationship = this.db.query(`
      INSERT INTO document_relationships (from_key, to_key, relation_type, section, sort_order)
      VALUES ($from_key, $to_key, $relation_type, $section, $sort_order)
      ON CONFLICT(from_key, to_key, relation_type) DO UPDATE SET
        section = $section,
        sort_order = $sort_order
    `)
    this._searchDocuments = this.db.query(`
      SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
             d.declaration_text as declaration, d.platforms_json as platforms,
             COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
             d.source_type as source_type, d.source_metadata as source_metadata,
             bm25(documents_fts, 10.0, 5.0, 3.0, 2.0, 1.0) as rank,
             CASE
               WHEN LOWER(d.title) = LOWER($raw) THEN 0
               WHEN LOWER(d.key) = LOWER($raw) THEN 0
               WHEN LOWER(d.title) LIKE LOWER($raw) || '%' THEN 1
               WHEN INSTR(LOWER(d.title), LOWER($raw)) > 0 THEN 2
               ELSE 3
             END as tier
      FROM documents_fts
      JOIN documents d ON documents_fts.rowid = d.id
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE documents_fts MATCH $query
        AND ($framework IS NULL OR d.framework = $framework)
        AND ($kind IS NULL OR d.kind = $kind OR d.role = $kind)
      ORDER BY tier, rank
      LIMIT $limit
    `)
    this._searchDocumentsTrigram = this.db.query(`
      SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
             d.declaration_text as declaration, d.platforms_json as platforms,
             COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
             d.source_type as source_type, d.source_metadata as source_metadata
      FROM documents_trigram
      JOIN documents d ON documents_trigram.rowid = d.id
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE documents_trigram MATCH $query
        AND ($framework IS NULL OR d.framework = $framework)
        AND ($kind IS NULL OR d.kind = $kind OR d.role = $kind)
      LIMIT $limit
    `)
    this._searchDocumentsBody = this.db.query(`
      SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
             d.declaration_text as declaration, d.platforms_json as platforms,
             COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
             d.source_type as source_type, d.source_metadata as source_metadata,
             bm25(documents_body_fts, 1.0) as rank
      FROM documents_body_fts
      JOIN documents d ON documents_body_fts.rowid = d.id
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE documents_body_fts MATCH $query
        AND ($framework IS NULL OR d.framework = $framework)
        AND ($kind IS NULL OR d.kind = $kind OR d.role = $kind)
      ORDER BY rank
      LIMIT $limit
    `)
    this._documentsBodyIndexCount = this.db.query('SELECT COUNT(*) as c FROM documents_body_fts')
    this._insertDocumentBody = this.db.query('INSERT OR REPLACE INTO documents_body_fts(rowid, body) VALUES ($id, $body)')
    this._clearDocumentBody = this.db.query("DELETE FROM documents_body_fts")
    this._deleteDocumentBody = this.db.query('DELETE FROM documents_body_fts WHERE rowid = ?')
    this._documentTrigramCandidates = this.db.query(`
      SELECT d.id, d.title
      FROM documents_trigram
      JOIN documents d ON documents_trigram.rowid = d.id
      WHERE documents_trigram MATCH $trigram
    `)
    this._searchDocumentByTitle = this.db.query(`
      SELECT d.*, COALESCE(r.slug, d.framework) as root_slug, COALESCE(r.display_name, d.framework) as framework
      FROM documents d
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE d.title = $title
        AND ($framework IS NULL OR d.framework = $framework)
      ORDER BY CASE WHEN d.role = 'symbol' OR d.kind = 'symbol' THEN 0 ELSE 1 END, length(d.key)
      LIMIT 1
    `)
    this._getDocumentsByRole = this.db.query(`
      SELECT d.key, d.key as path, d.title, d.role,
             COALESCE(r.slug, d.framework) as root_slug, d.source_type as source_type
      FROM documents d
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE d.role = ?
      ORDER BY d.key
    `)
    this._getDocumentSearchRecordById = this.db.query(`
      SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
             d.declaration_text as declaration, d.platforms_json as platforms,
             COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
             d.source_type as source_type, d.source_metadata as source_metadata
      FROM documents d
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE d.id = ?
    `)
    this._deleteDocumentByKey = this.db.query('DELETE FROM documents WHERE key = ?')
    this._getPageSearchRecordById = this.db.query(`
      SELECT p.path, p.title, p.role, p.role_heading, p.abstract,
             p.declaration, p.platforms, r.display_name as framework, r.slug as root_slug,
             COALESCE(p.source_type, r.source_type) as source_type,
             p.source_metadata as source_metadata
      FROM pages p
      JOIN roots r ON p.root_id = r.id
      WHERE p.id = ? AND p.status = 'active'
    `)

    this._addRef = this.db.query('INSERT INTO refs (source_id, target_path, anchor_text, section) VALUES (?, ?, ?, ?)')
    this._getRefsBySource = this.db.query('SELECT target_path, anchor_text, section FROM refs WHERE source_id = ? ORDER BY section, anchor_text')
    this._deleteRefsBySource = this.db.query('DELETE FROM refs WHERE source_id = ?')

    this._setCrawlState = this.db.query(`
      INSERT INTO crawl_state (path, status, root_slug, depth, error)
      VALUES ($path, $status, $root_slug, $depth, $error)
      ON CONFLICT(path) DO UPDATE SET status = $status, error = $error
    `)
    this._getPendingCrawl = this.db.query("SELECT path, depth FROM crawl_state WHERE status = 'pending' AND root_slug = ? LIMIT ?")
    this._resetFailedCrawl = this.db.query("UPDATE crawl_state SET status = 'pending', error = NULL WHERE status = 'failed' AND root_slug = ?")
    this._countFailed = this.db.query("SELECT COUNT(*) as count FROM crawl_state WHERE status = 'failed' AND root_slug = ?")
    this._countCrawlState = this.db.query('SELECT status, COUNT(*) as count FROM crawl_state WHERE root_slug = ? GROUP BY status')
    this._clearCrawlState = this.db.query('DELETE FROM crawl_state WHERE root_slug = ?')

    this._addUpdateLog = this.db.query(`
      INSERT INTO update_log (timestamp, root_slug, action, new_count, mod_count, del_count, err_count, duration_ms)
      VALUES ($timestamp, $root_slug, $action, $new_count, $mod_count, $del_count, $err_count, $duration_ms)
    `)
    this._getLastUpdateLog = this.db.query("SELECT * FROM update_log ORDER BY id DESC LIMIT 1")

    this._updatePageConverted = this.db.query("UPDATE pages SET converted_at = ? WHERE path = ?")
    this._getUnconvertedPages = this.db.query(`
      SELECT p.path, r.slug as root_slug, COALESCE(p.source_type, r.source_type) as source_type
      FROM pages p
      JOIN roots r ON p.root_id = r.id
      WHERE p.converted_at IS NULL
        AND p.downloaded_at IS NOT NULL
        AND p.status = 'active'
    `)
    this._updateRootPageCount = this.db.query("UPDATE roots SET page_count = (SELECT COUNT(*) FROM pages WHERE root_id = roots.id AND status = 'active') WHERE slug = ?")
    this._getAllPagesWithEtag = this.db.query("SELECT path, etag FROM pages WHERE etag IS NOT NULL AND status = 'active'")
    this._getPagesBySourceType = this.db.query(`
      SELECT p.path, p.root_id, p.etag, p.last_modified, p.content_hash,
             r.slug as root_slug, COALESCE(p.source_type, r.source_type) as source_type
      FROM pages p
      JOIN roots r ON p.root_id = r.id
      WHERE p.status = 'active'
        AND COALESCE(p.source_type, r.source_type) = ?
      ORDER BY p.path
    `)
    this._markPageDeleted = this.db.query("UPDATE pages SET status = 'deleted' WHERE path = ?")
    this._updatePageEtag = this.db.query("UPDATE pages SET etag = $etag, last_modified = $last_modified, content_hash = $content_hash, downloaded_at = $downloaded_at WHERE path = $path")

    // Activity tracking
    this._setActivity = this.db.query("INSERT OR REPLACE INTO activity (id, action, started_at, pid, roots) VALUES (1, $action, $started_at, $pid, $roots)")
    this._clearActivity = this.db.query("DELETE FROM activity WHERE id = 1")
    this._getActivity = this.db.query("SELECT * FROM activity WHERE id = 1")

    // Per-root crawl progress
    this._crawlProgressByRoot = this.db.query(`
      SELECT root_slug,
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
             SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) as processed,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM crawl_state
      GROUP BY root_slug
      ORDER BY root_slug
    `)
    this._crawlProgressAll = this.db.query(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) as processed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        COUNT(*) as total
      FROM crawl_state
    `)
  }

  upsertRoot(slug, displayName, kind, source, seedPath = null) {
    const now = new Date().toISOString()
    return this._upsertRoot.get({
      $slug: slug,
      $display_name: displayName,
      $kind: kind,
      $source: source,
      $seed_path: seedPath,
      $source_type: deriveRootSourceType(slug, kind),
      $now: now,
    })
  }

  upsertPage(params) {
    const root = params.rootId ? this._getRootById.get(params.rootId) : null
    const sourceType = params.sourceType ?? root?.source_type ?? 'apple-docc'
    const urlDepth = params.urlDepth ?? Math.max(0, (params.path?.split('/').length ?? 1) - 1)

    const page = this._upsertPage.get({
      $root_id: params.rootId,
      $path: params.path,
      $url: params.url,
      $title: params.title ?? null,
      $role: params.role ?? null,
      $role_heading: params.roleHeading ?? null,
      $abstract: params.abstract ?? null,
      $platforms: serializePlatforms(params.platforms),
      $declaration: params.declaration ?? null,
      $etag: params.etag ?? null,
      $last_modified: params.lastModified ?? null,
      $content_hash: params.contentHash ?? null,
      $downloaded_at: params.downloadedAt ?? null,
      $source_type: sourceType,
      $language: params.language ?? null,
      $is_release_notes: params.isReleaseNotes == null ? 0 : (params.isReleaseNotes ? 1 : 0),
      $url_depth: urlDepth,
      $doc_kind: params.docKind ?? params.role ?? null,
      $source_metadata: params.sourceMetadata == null ? null : (typeof params.sourceMetadata === 'string' ? params.sourceMetadata : JSON.stringify(params.sourceMetadata)),
      $min_ios: params.minIos ?? null,
      $min_macos: params.minMacos ?? null,
      $min_watchos: params.minWatchos ?? null,
      $min_tvos: params.minTvos ?? null,
      $min_visionos: params.minVisionos ?? null,
    })

    if (params.skipDocumentSync !== true) {
      this.upsertDocument({
        sourceType,
        key: params.path,
        title: params.title ?? params.path,
        kind: params.docKind ?? params.role ?? null,
        role: params.role ?? null,
        roleHeading: params.roleHeading ?? null,
        framework: root?.slug ?? params.framework ?? deriveFrameworkFromPath(params.path),
        url: params.url ?? null,
        language: params.language ?? null,
        abstractText: params.abstract ?? null,
        declarationText: params.declaration ?? null,
        headings: params.headings ?? null,
        platformsJson: serializePlatforms(params.platforms),
        minIos: params.minIos ?? null,
        minMacos: params.minMacos ?? null,
        minWatchos: params.minWatchos ?? null,
        minTvos: params.minTvos ?? null,
        minVisionos: params.minVisionos ?? null,
        isDeprecated: params.isDeprecated ?? false,
        isBeta: params.isBeta ?? false,
        isReleaseNotes: params.isReleaseNotes ?? false,
        urlDepth,
        sourceMetadata: params.sourceMetadata ?? null,
        contentHash: params.contentHash ?? null,
        rawPayloadHash: params.contentHash ?? null,
      })
    }

    return page
  }

  hasNormalizedDocuments() {
    if (this._hasNormalizedDocsCache !== undefined) return this._hasNormalizedDocsCache
    try {
      this._hasNormalizedDocsCache = this._normalizedDocumentCount.get().count > 0
      return this._hasNormalizedDocsCache
    } catch { return false }
  }

  /** Invalidate the normalized documents cache (call after bulk inserts). */
  invalidateNormalizedDocsCache() {
    this._hasNormalizedDocsCache = undefined
  }

  upsertDocument(params) {
    this._hasNormalizedDocsCache = true // After any upsert, normalized docs exist
    const now = new Date().toISOString()
    return this._upsertDocument.get({
      $source_type: params.sourceType ?? 'apple-docc',
      $key: params.key,
      $title: params.title ?? params.key,
      $kind: params.kind ?? null,
      $role: params.role ?? null,
      $role_heading: params.roleHeading ?? null,
      $framework: params.framework ?? deriveFrameworkFromPath(params.key),
      $url: params.url ?? null,
      $language: params.language ?? null,
      $abstract_text: params.abstractText ?? null,
      $declaration_text: params.declarationText ?? null,
      $headings: params.headings ?? null,
      $platforms_json: serializePlatforms(params.platformsJson),
      $min_ios: params.minIos ?? null,
      $min_macos: params.minMacos ?? null,
      $min_watchos: params.minWatchos ?? null,
      $min_tvos: params.minTvos ?? null,
      $min_visionos: params.minVisionos ?? null,
      $is_deprecated: params.isDeprecated == null ? null : (params.isDeprecated ? 1 : 0),
      $is_beta: params.isBeta == null ? null : (params.isBeta ? 1 : 0),
      $is_release_notes: params.isReleaseNotes == null ? null : (params.isReleaseNotes ? 1 : 0),
      $url_depth: params.urlDepth ?? null,
      $source_metadata: params.sourceMetadata == null ? null : (typeof params.sourceMetadata === 'string' ? params.sourceMetadata : JSON.stringify(params.sourceMetadata)),
      $content_hash: params.contentHash ?? null,
      $raw_payload_hash: params.rawPayloadHash ?? null,
      $now: now,
    })
  }

  replaceDocumentSections(documentId, sections) {
    this._deleteDocumentSections.run(documentId)
    for (const section of sections ?? []) {
      this._insertDocumentSection.run({
        $document_id: documentId,
        $section_kind: section.sectionKind ?? section.section_kind,
        $heading: section.heading ?? null,
        $content_text: section.contentText ?? section.content_text ?? '',
        $content_json: section.contentJson ?? section.content_json ?? null,
        $sort_order: section.sortOrder ?? section.sort_order ?? 0,
      })
    }
  }

  replaceDocumentRelationships(fromKey, relationships) {
    this._deleteDocumentRelationships.run(fromKey)
    for (const relationship of relationships ?? []) {
      this._insertDocumentRelationship.run({
        $from_key: relationship.fromKey ?? relationship.from_key ?? fromKey,
        $to_key: relationship.toKey ?? relationship.to_key,
        $relation_type: relationship.relationType ?? relationship.relation_type,
        $section: relationship.section ?? null,
        $sort_order: relationship.sortOrder ?? relationship.sort_order ?? 0,
      })
    }
  }

  upsertNormalizedDocument(normalized, hashes = {}) {
    const documentId = this.upsertDocument({
      ...normalized.document,
      contentHash: hashes.contentHash ?? null,
      rawPayloadHash: hashes.rawPayloadHash ?? null,
    }).id

    this.replaceDocumentSections(documentId, normalized.sections)
    this.replaceDocumentRelationships(normalized.document.key, normalized.relationships)
    return documentId
  }

  getPage(path) {
    if (this.hasNormalizedDocuments()) {
      const document = this._getDocument.get(path)
      if (document) {
        return {
          ...document,
          path: document.key,
          framework: document.framework_display,
          abstract: document.abstract_text,
          declaration: document.declaration_text,
          platforms: document.platforms_json,
          downloaded_at: null,
          converted_at: null,
        }
      }
    }
    return this._getPage.get(path, 'active')
  }

  getPageByPath(path) {
    return this._getPage.get(path, 'active')
  }

  getDocumentSections(key) {
    const document = this._getDocument.get(key)
    if (!document) return []
    return this._getDocumentSections.all(document.id).map(section => ({
      sectionKind: section.section_kind,
      heading: section.heading,
      contentText: section.content_text,
      contentJson: section.content_json,
      sortOrder: section.sort_order,
    }))
  }

  getDocumentRelationships(key) {
    return this._getDocumentRelationshipsBySource.all(key)
  }

  getPagesByRoot(rootSlug) {
    if (this.hasNormalizedDocuments()) {
      return this._getDocumentsByRoot.all(rootSlug)
    }
    return this._getPagesByRoot.all(rootSlug)
  }

  searchPages(ftsQuery, rawQuery, { framework = null, kind = null, limit = 100 } = {}) {
    if (this.hasNormalizedDocuments()) {
      return this._searchDocuments.all({ $query: ftsQuery, $raw: rawQuery, $framework: framework, $kind: kind, $limit: limit })
    }
    return this._searchPages.all({ $query: ftsQuery, $raw: rawQuery, $framework: framework, $kind: kind, $limit: limit })
  }

  searchTrigram(query, { framework = null, kind = null, limit = 100 } = {}) {
    try {
      if (this.hasNormalizedDocuments()) {
        return this._searchDocumentsTrigram.all({ $query: query, $framework: framework, $kind: kind, $limit: limit })
      }
      return this._searchTrigram.all({ $query: query, $framework: framework, $kind: kind, $limit: limit })
    } catch { return [] }
  }

  searchBody(ftsQuery, { framework = null, kind = null, limit = 100 } = {}) {
    try {
      if (this.hasNormalizedDocuments()) {
        return this._searchDocumentsBody.all({ $query: ftsQuery, $framework: framework, $kind: kind, $limit: limit })
      }
      return this._searchBody.all({ $query: ftsQuery, $framework: framework, $kind: kind, $limit: limit })
    } catch { return [] }
  }

  getBodyIndexCount() {
    if (this.hasNormalizedDocuments()) {
      try { return this._documentsBodyIndexCount.get().c } catch {}
    }
    try { return this._bodyIndexCount.get().c } catch { return 0 }
  }

  insertBody(pageId, body) {
    if (this.hasNormalizedDocuments()) {
      this._insertDocumentBody.run({ $id: pageId, $body: body })
      return
    }
    this._insertBody.run({ $id: pageId, $body: body })
  }

  clearBodyIndex() {
    if (this.hasNormalizedDocuments()) {
      this._clearDocumentBody.run()
      return
    }
    this._clearBody.run()
  }

  getTrigramCandidates(trigram) {
    try {
      if (this.hasNormalizedDocuments()) {
        return this._documentTrigramCandidates.all({ $trigram: trigram })
      }
      return this._trigramCandidates.all({ $trigram: trigram })
    } catch { return [] }
  }

  searchByTitle(title, framework = null) {
    if (this.hasNormalizedDocuments()) {
      return this._searchDocumentByTitle.get({ $title: title, $framework: framework })
    }
    return this._searchByTitle.get({ $title: title, $framework: framework })
  }

  getSearchRecordById(id) {
    if (this.hasNormalizedDocuments()) {
      return this._getDocumentSearchRecordById.get(id)
    }
    return this._getPageSearchRecordById.get(id)
  }

  getRoots(kind = null) {
    return kind ? this._getRootsByKind.all(kind) : this._getRoots.all()
  }

  getRootBySlug(slug) {
    return this._getRootBySlug.get(slug)
  }

  /**
   * Resolve a root by exact slug, then by case-insensitive slug/display_name substring.
   * Returns the best match or null.
   */
  resolveRoot(input) {
    // Exact match first
    const exact = this._getRootBySlug.get(input)
    if (exact) return exact

    // Fuzzy: case-insensitive match on slug or display_name
    const lower = input.toLowerCase()
    const all = this._getRoots.all()
    return all.find(r => r.slug.toLowerCase() === lower)
      ?? all.find(r => r.display_name.toLowerCase().includes(lower))
      ?? all.find(r => r.slug.includes(lower))
      ?? null
  }

  addRef(sourceId, targetPath, anchorText, section) {
    this._addRef.run(sourceId, targetPath, anchorText, section)
  }

  deleteRefsBySource(sourceId) {
    this._deleteRefsBySource.run(sourceId)
  }

  getRefsBySource(sourceId) {
    return this._getRefsBySource.all(sourceId)
  }

  setCrawlState(path, status, rootSlug, depth = 0, error = null) {
    this._setCrawlState.run({ $path: path, $status: status, $root_slug: rootSlug, $depth: depth, $error: error })
  }

  seedCrawlIfNew(path, rootSlug, depth = 0) {
    // Only insert if not already known
    const existing = this.db.query('SELECT 1 FROM crawl_state WHERE path = ?').get(path)
    if (!existing) {
      this.setCrawlState(path, 'pending', rootSlug, depth)
      return true
    }
    return false
  }

  getPendingCrawl(rootSlug, limit = 10) {
    return this._getPendingCrawl.all(rootSlug, limit)
  }

  resetFailedCrawl(rootSlug) {
    return this._resetFailedCrawl.run(rootSlug)
  }

  countFailed(rootSlug) {
    return this._countFailed.get(rootSlug).count
  }

  getCrawlStats(rootSlug) {
    const rows = this._countCrawlState.all(rootSlug)
    const stats = { pending: 0, processed: 0, failed: 0 }
    for (const row of rows) stats[row.status] = row.count
    return stats
  }

  clearCrawlState(rootSlug) {
    this._clearCrawlState.run(rootSlug)
  }

  addUpdateLog(params) {
    this._addUpdateLog.run({
      $timestamp: new Date().toISOString(),
      $root_slug: params.rootSlug ?? null,
      $action: params.action,
      $new_count: params.newCount ?? 0,
      $mod_count: params.modCount ?? 0,
      $del_count: params.delCount ?? 0,
      $err_count: params.errCount ?? 0,
      $duration_ms: params.durationMs ?? null,
    })
  }

  getLastUpdateLog() {
    return this._getLastUpdateLog.get()
  }

  markConverted(path) {
    this._updatePageConverted.run(new Date().toISOString(), path)
  }

  getUnconvertedPages() {
    return this._getUnconvertedPages.all()
  }

  updateRootPageCount(slug) {
    this._updateRootPageCount.run(slug)
  }

  getAllPagesWithEtag() {
    return this._getAllPagesWithEtag.all()
  }

  getPagesBySourceType(sourceType) {
    return this._getPagesBySourceType.all(sourceType)
  }

  getPagesByRole(role) {
    if (this.hasNormalizedDocuments()) {
      return this._getDocumentsByRole.all(role)
    }
    return this._getPagesByRole.all(role)
  }

  markPageDeleted(path) {
    this._markPageDeleted.run(path)
    this.deleteNormalizedDocument(path)
  }

  deleteNormalizedDocument(key) {
    const document = this._getDocumentIdByKey.get(key)
    if (!document) return false

    this._deleteDocumentBody.run(document.id)
    this._deleteDocumentSections.run(document.id)
    this._deleteDocumentRelationshipsByKey.run(key, key)
    this._deleteDocumentByKey.run(key)
    return true
  }

  updatePageAfterDownload(path, etag, lastModified, contentHash) {
    this._updatePageEtag.run({
      $path: path,
      $etag: etag,
      $last_modified: lastModified,
      $content_hash: contentHash,
      $downloaded_at: new Date().toISOString(),
    })
  }

  setActivity(action, roots = null) {
    this._setActivity.run({
      $action: action,
      $started_at: new Date().toISOString(),
      $pid: process.pid,
      $roots: roots ? JSON.stringify(roots) : null,
    })
  }

  clearActivity() {
    this._clearActivity.run()
  }

  getActivity() {
    const row = this._getActivity.get()
    if (!row) return null

    // Check if the process is still alive
    try {
      process.kill(row.pid, 0) // signal 0 = existence check
      return { ...row, alive: true, roots: row.roots ? JSON.parse(row.roots) : null }
    } catch {
      // Process is dead — stale activity from a killed run
      return { ...row, alive: false, roots: row.roots ? JSON.parse(row.roots) : null }
    }
  }

  getCrawlProgressByRoot() {
    return this._crawlProgressByRoot.all()
  }

  getCrawlProgressAll() {
    return this._crawlProgressAll.get() ?? { pending: 0, processed: 0, failed: 0, total: 0 }
  }

  getStats() {
    const totalPages = this.db.query("SELECT COUNT(*) as count FROM pages WHERE status = 'active'").get().count
    const totalDeleted = this.db.query("SELECT COUNT(*) as count FROM pages WHERE status = 'deleted'").get().count
    const totalRoots = this.db.query('SELECT COUNT(*) as count FROM roots').get().count
    const rootsByKind = this.db.query('SELECT kind, COUNT(*) as count FROM roots GROUP BY kind').all()
    const lastLog = this.getLastUpdateLog()
    const activity = this.getActivity()
    const crawlProgress = this.getCrawlProgressAll()
    const crawlByRoot = this.getCrawlProgressByRoot()
    return { totalPages, totalDeleted, totalRoots, rootsByKind, lastLog, activity, crawlProgress, crawlByRoot }
  }

  close() {
    this.db.close()
  }
}

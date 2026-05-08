import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fuzzyMatchTitles } from '../lib/fuzzy.js'

const SCHEMA_VERSION = 13

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

CREATE TABLE IF NOT EXISTS sync_checkpoint (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_render_index (
  doc_id           INTEGER PRIMARY KEY,
  sections_digest  TEXT    NOT NULL,
  template_version TEXT    NOT NULL,
  html_hash        TEXT    NOT NULL,
  updated_at       INTEGER NOT NULL
);

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
);

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

const ROOT_SOURCE_TYPE_BY_SLUG = new Map([
  ['app-store-review', 'guidelines'],
  ['design', 'hig'],
  ['apple-archive', 'apple-archive'],
  ['packages', 'packages'],
  ['sample-code', 'sample-code'],
  ['swift-book', 'swift-book'],
  ['swift-evolution', 'swift-evolution'],
  ['swift-org', 'swift-org'],
  ['wwdc', 'wwdc'],
])

function deriveRootSourceType(slug, kind) {
  if (ROOT_SOURCE_TYPE_BY_SLUG.has(slug)) return ROOT_SOURCE_TYPE_BY_SLUG.get(slug)
  if (kind === 'guidelines') return 'guidelines'
  if (kind === 'design') return 'hig'
  return 'apple-docc'
}

// Shared filter clause for every search tier. The framework predicate is
// emitted in two shapes — see the comment at the prepared-statement site
// for the EXPLAIN QUERY PLAN difference. All other filters keep OR-NULL.
function searchFilterClauses(frameworkBound) {
  return [
    frameworkBound ? 'd.framework = $framework' : '($framework IS NULL OR d.framework = $framework)',
    '($source_type IS NULL OR d.source_type = $source_type)',
    `(
      $kind IS NULL
      OR LOWER(COALESCE(d.role_heading, '')) = LOWER($kind)
      OR LOWER(COALESCE(d.kind, '')) = LOWER($kind)
      OR LOWER(COALESCE(d.role, '')) = LOWER($kind)
    )`,
    "($language IS NULL OR d.language IS NULL OR d.language = $language OR d.language = 'both')",
    '($min_ios IS NULL OR d.min_ios IS NULL OR d.min_ios <= $min_ios)',
    '($min_macos IS NULL OR d.min_macos IS NULL OR d.min_macos <= $min_macos)',
    '($min_watchos IS NULL OR d.min_watchos IS NULL OR d.min_watchos <= $min_watchos)',
    '($min_tvos IS NULL OR d.min_tvos IS NULL OR d.min_tvos <= $min_tvos)',
    '($min_visionos IS NULL OR d.min_visionos IS NULL OR d.min_visionos <= $min_visionos)',
  ].join('\n        AND ')
}

const SEARCH_DOCUMENT_COLUMNS = `d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
       d.declaration_text as declaration, d.platforms_json as platforms,
       d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos,
       COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
       d.source_type as source_type, d.source_metadata as source_metadata,
       d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta, d.kind as doc_kind, d.language`

function buildFtsSearchSql({ frameworkBound }) {
  return `
    SELECT ${SEARCH_DOCUMENT_COLUMNS},
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
      AND ${searchFilterClauses(frameworkBound)}
    ORDER BY tier, rank
    LIMIT $limit
  `
}

function buildTitleExactSearchSql({ frameworkBound }) {
  return `
    SELECT ${SEARCH_DOCUMENT_COLUMNS},
           0 as rank,
           0 as tier
    FROM documents d
    LEFT JOIN roots r ON r.slug = d.framework
    WHERE d.title = $raw COLLATE NOCASE
      AND ${searchFilterClauses(frameworkBound)}
    ORDER BY tier, CASE WHEN d.role = 'symbol' OR d.kind = 'symbol' THEN 0 ELSE 1 END, length(d.key)
    LIMIT $limit
  `
}

function buildTrigramSearchSql({ frameworkBound }) {
  return `
    SELECT ${SEARCH_DOCUMENT_COLUMNS}
    FROM documents_trigram
    JOIN documents d ON documents_trigram.rowid = d.id
    LEFT JOIN roots r ON r.slug = d.framework
    WHERE documents_trigram MATCH $query
      AND ${searchFilterClauses(frameworkBound)}
    LIMIT $limit
  `
}

function buildBodySearchSql({ frameworkBound }) {
  return `
    SELECT ${SEARCH_DOCUMENT_COLUMNS},
           bm25(documents_body_fts, 1.0) as rank
    FROM documents_body_fts
    JOIN documents d ON documents_body_fts.rowid = d.id
    LEFT JOIN roots r ON r.slug = d.framework
    WHERE documents_body_fts MATCH $query
      AND ${searchFilterClauses(frameworkBound)}
    ORDER BY rank
    LIMIT $limit
  `
}

export class DocsDatabase {
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    }

    this.dbPath = dbPath
    this.db = new Database(dbPath)
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('PRAGMA synchronous = NORMAL')
    this.db.run('PRAGMA cache_size = -64000')
    this.db.run('PRAGMA temp_store = MEMORY')
    this.db.run('PRAGMA busy_timeout = 5000')
    // 10 GB virtual address space for memory-mapped I/O. SQLite caps this at
    // both the compiled SQLITE_MAX_MMAP_SIZE and the actual DB file size, so
    // a small corpus simply maps the whole file. Pages are demand-paged via
    // the OS unified page cache — no physical RAM is reserved up front.
    // Biggest win is on FTS5 index scans: zero syscalls and no double-buffer
    // through SQLite's page cache.
    this.db.run('PRAGMA mmap_size = 10737418240')
    // Write-side: let the WAL grow to ~8 MB (with 4 KB pages) before
    // auto-checkpointing. Reduces checkpoint churn during `apple-docs
    // update` without affecting concurrent readers under WAL.
    this.db.run('PRAGMA wal_autocheckpoint = 2000')
    // Read back the effective mmap size — if the Bun SQLite build caps
    // lower than requested, operators will see it in diagnostics via
    // `getEffectiveMmapSize()` rather than silently running without mmap.
    try {
      const row = this.db.query('PRAGMA mmap_size').get()
      this._effectiveMmapSize = row ? Number(row.mmap_size ?? Object.values(row)[0] ?? 0) : 0
    } catch {
      this._effectiveMmapSize = 0
    }
    this._migrate()
    this._prepareStatements()
  }

  getEffectiveMmapSize() {
    return this._effectiveMmapSize ?? 0
  }

  _migrate() {
    // Check existing version before starting
    this.db.run('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = this.db.query('SELECT value FROM schema_meta WHERE key = ?').get('schema_version')
    const current = row ? Number.parseInt(row.value, 10) : 0

    // Refuse to open a database from a newer version (downgrade protection)
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${current} is newer than supported version ${SCHEMA_VERSION}. Update apple-docs to a newer version.`
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
          ['metalperformanceshaders', 'metal'],
          ['foundation', 'nsobject'],
          ['swiftui', 'declarativeui'],
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
      if (current < 7) {
        for (const [slug, sourceType] of ROOT_SOURCE_TYPE_BY_SLUG) {
          this.db.run('UPDATE roots SET source_type = ? WHERE slug = ?', [sourceType, slug])
          this.db.run(`
            UPDATE pages
            SET source_type = ?
            WHERE root_id IN (SELECT id FROM roots WHERE slug = ?)
          `, [sourceType, slug])
          this.db.run(`
            UPDATE documents
            SET source_type = ?
            WHERE key = ? OR key LIKE ?
          `, [sourceType, slug, `${slug}/%`])
        }
      }
      if (current < 8) {
        this.db.run(`CREATE TABLE IF NOT EXISTS sync_checkpoint (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`)
      }
      if (current < 9) {
        this.db.run(`CREATE TABLE IF NOT EXISTS document_render_index (
          doc_id           INTEGER PRIMARY KEY,
          sections_digest  TEXT    NOT NULL,
          template_version TEXT    NOT NULL,
          html_hash        TEXT    NOT NULL,
          updated_at       INTEGER NOT NULL
        )`)
      }
      if (current < 10) {
        this.db.exec(`
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
        `)
      }
      if (current < 11) {
        this.db.exec(`
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
        `)
      }
      if (current < 12) {
        // Add typography classification columns. The unique constraint on
        // apple_font_files moves from (family_id, file_path) to
        // (family_id, file_name) — the same physical font discovered in
        // multiple disk locations is now one row, with `source` recording
        // which copy we kept (preferring 'remote' = downloaded DMG over
        // 'system' = /Library/Fonts).
        try { this.db.run('ALTER TABLE apple_font_families ADD COLUMN category TEXT') } catch {}
        try { this.db.run("ALTER TABLE apple_font_files ADD COLUMN source TEXT NOT NULL DEFAULT 'remote'") } catch {}
        try { this.db.run('ALTER TABLE apple_font_files ADD COLUMN is_variable INTEGER NOT NULL DEFAULT 0') } catch {}
        try { this.db.run('ALTER TABLE apple_font_files ADD COLUMN axes_json TEXT') } catch {}
        try { this.db.run('ALTER TABLE apple_font_files ADD COLUMN variant TEXT') } catch {}
        try { this.db.run('ALTER TABLE apple_font_files ADD COLUMN italic INTEGER NOT NULL DEFAULT 0') } catch {}
        // Drop legacy duplicates (same family + file_name across multiple
        // disk paths) before tightening the constraint. Keep the row whose
        // path lives under the user's apple-docs data dir so the cached
        // download stays canonical.
        this.db.run(`
          DELETE FROM apple_font_files
          WHERE rowid NOT IN (
            SELECT MIN(rowid)
            FROM apple_font_files
            GROUP BY family_id, file_name
            ORDER BY CASE WHEN file_path LIKE '%/.apple-docs/resources/fonts/extracted/%' THEN 0 ELSE 1 END
          )
        `)
        // Rebuild apple_font_files with the new UNIQUE(family_id, file_name)
        // constraint. SQLite cannot DROP/ADD UNIQUE in place, so go via a
        // shadow table.
        this.db.exec(`
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
        `)
      }
      if (current < 13) {
        // Hot search/lookup path: exact symbol-title lookups previously scanned
        // the whole documents table on the full corpus.
        this.db.run('CREATE INDEX IF NOT EXISTS idx_documents_title_nocase ON documents(title COLLATE NOCASE)')
      }
      this.db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)])
      this.db.run('COMMIT')
    } catch (e) {
      this.db.run('ROLLBACK')
      throw new Error(`Migration from v${current} to v${SCHEMA_VERSION} failed: ${e.message}`)
    }
  }

  /**
   * Check if a table exists in the database.
   * @param {string} name
   * @returns {boolean}
   */
  hasTable(name) {
    return !!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  }

  /**
   * Run a synchronous unit of work inside a transaction.
   * Rolls back on error and returns the callback result on success.
   * @template T
   * @param {(db: DocsDatabase) => T} fn
   * @returns {T}
   */
  tx(fn) {
    this.db.run('BEGIN IMMEDIATE')
    try {
      const result = fn(this)
      if (result && typeof result.then === 'function') {
        throw new Error('DocsDatabase.tx() callback must be synchronous')
      }
      this.db.run('COMMIT')
      return result
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
  }

  /**
   * Return the snapshot tier (lite/standard/full) or null for non-snapshot databases.
   * Reads from snapshot_meta, falls back to capability probing.
   * @returns {string|null}
   */
  getTier() {
    if (this._tier !== undefined) return this._tier
    try {
      const row = this.db.query("SELECT value FROM snapshot_meta WHERE key='snapshot_tier'").get()
      if (row) { this._tier = row.value; return this._tier }
    } catch {}
    // Capability probing fallback: lite tier drops document_sections entirely
    if (this.hasTable('document_sections')) {
      this._tier = 'standard'
    } else if (this.hasTable('documents')) {
      this._tier = 'lite'
    } else {
      this._tier = null
    }
    return this._tier
  }

  /**
   * Ensure the document_sections table exists (e.g. for lite snapshots where it was dropped).
   * Creates the table and re-prepares the affected statements.
   */
  ensureSectionsTable() {
    if (this.hasTable('document_sections')) return
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
    this._deleteDocumentSections = this.db.query('DELETE FROM document_sections WHERE document_id = ?')
    this._insertDocumentSection = this.db.query(`
      INSERT INTO document_sections (document_id, section_kind, heading, content_text, content_json, sort_order)
      VALUES ($document_id, $section_kind, $heading, $content_text, $content_json, $sort_order)
      ON CONFLICT(document_id, section_kind, sort_order) DO UPDATE SET
        heading = $heading,
        content_text = $content_text,
        content_json = $content_json
    `)
  }

  _prepareStatements() {
    // Detect available tier-optional tables once
    const hasSections = this.hasTable('document_sections')
    const hasTrigram = this.hasTable('documents_trigram')
    const hasBodyFts = this.hasTable('documents_body_fts')

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

    this._getDocumentsByRoot = this.db.query(`
      SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract
      FROM documents d
      JOIN pages p ON p.path = d.key
      JOIN roots r ON p.root_id = r.id
      WHERE r.slug = ? AND p.status = 'active'
      ORDER BY d.key
    `)

    this._getRoots = this.db.query('SELECT * FROM roots ORDER BY slug')
    this._getRootsByKind = this.db.query('SELECT * FROM roots WHERE kind = ? ORDER BY slug')
    this._getRootBySlug = this.db.query('SELECT * FROM roots WHERE slug = ?')
    this._getRootById = this.db.query('SELECT * FROM roots WHERE id = ?')

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
    this._getDocumentSections = hasSections ? this.db.query(`
      SELECT section_kind, heading, content_text, content_json, sort_order
      FROM document_sections
      WHERE document_id = ?
      ORDER BY sort_order, id
    `) : null
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
    this._deleteDocumentSections = hasSections ? this.db.query('DELETE FROM document_sections WHERE document_id = ?') : null
    this._insertDocumentSection = hasSections ? this.db.query(`
      INSERT INTO document_sections (document_id, section_kind, heading, content_text, content_json, sort_order)
      VALUES ($document_id, $section_kind, $heading, $content_text, $content_json, $sort_order)
      ON CONFLICT(document_id, section_kind, sort_order) DO UPDATE SET
        heading = $heading,
        content_text = $content_text,
        content_json = $content_json
    `) : null
    this._deleteDocumentRelationships = this.db.query('DELETE FROM document_relationships WHERE from_key = ?')
    this._deleteDocumentRelationshipsByKey = this.db.query('DELETE FROM document_relationships WHERE from_key = ? OR to_key = ?')
    this._insertDocumentRelationship = this.db.query(`
      INSERT INTO document_relationships (from_key, to_key, relation_type, section, sort_order)
      VALUES ($from_key, $to_key, $relation_type, $section, $sort_order)
      ON CONFLICT(from_key, to_key, relation_type) DO UPDATE SET
        section = $section,
        sort_order = $sort_order
    `)
    // Two prepared statements per search tier: one with the framework
    // predicate as `($framework IS NULL OR d.framework = $framework)` for
    // unfiltered queries, one with `d.framework = $framework` for filtered
    // queries. The OR-NULL idiom looks innocent but blocks predicate
    // pushdown — SQLite scans the FTS virtual table over the whole corpus
    // and post-filters on the JOINed framework column. With a direct
    // equality binding the planner instead seeks `idx_documents_framework`
    // first and runs FTS only over the framework's rows. EXPLAIN QUERY
    // PLAN confirms the difference; on mm18 the swap drops cold-path
    // framework-filter p95 from ~33 ms (c=1) into the same band as the
    // unfiltered case.
    //
    // Other filter columns (kind, source_type, language, platform mins)
    // keep the OR-NULL pattern — they are bound less often and the index
    // selectivity wins are smaller, so the doubled prepared-statement cost
    // would not pay back.
    this._searchDocuments = this.db.query(buildFtsSearchSql({ frameworkBound: false }))
    this._searchDocumentsFw = this.db.query(buildFtsSearchSql({ frameworkBound: true }))
    this._searchDocumentsTitleExact = this.db.query(buildTitleExactSearchSql({ frameworkBound: false }))
    this._searchDocumentsTitleExactFw = this.db.query(buildTitleExactSearchSql({ frameworkBound: true }))
    this._searchDocumentsTrigram = hasTrigram
      ? this.db.query(buildTrigramSearchSql({ frameworkBound: false }))
      : null
    this._searchDocumentsTrigramFw = hasTrigram
      ? this.db.query(buildTrigramSearchSql({ frameworkBound: true }))
      : null
    this._searchDocumentsBody = hasBodyFts
      ? this.db.query(buildBodySearchSql({ frameworkBound: false }))
      : null
    this._searchDocumentsBodyFw = hasBodyFts
      ? this.db.query(buildBodySearchSql({ frameworkBound: true }))
      : null
    this._documentsBodyIndexCount = hasBodyFts ? this.db.query('SELECT COUNT(*) as c FROM documents_body_fts') : null
    this._insertDocumentBody = hasBodyFts ? this.db.query('INSERT OR REPLACE INTO documents_body_fts(rowid, body) VALUES ($id, $body)') : null
    this._clearDocumentBody = hasBodyFts ? this.db.query("DELETE FROM documents_body_fts") : null
    this._deleteDocumentBody = hasBodyFts ? this.db.query('DELETE FROM documents_body_fts WHERE rowid = ?') : null
    this._documentTrigramCandidates = hasTrigram ? this.db.query(`
      SELECT d.id, d.title
      FROM documents_trigram
      JOIN documents d ON documents_trigram.rowid = d.id
      WHERE documents_trigram MATCH $trigram
    `) : null
    this._searchDocumentByTitle = this.db.query(`
      SELECT d.*, COALESCE(r.slug, d.framework) as root_slug, COALESCE(r.display_name, d.framework) as framework
      FROM documents d
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE d.title = $title COLLATE NOCASE
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
             d.source_type as source_type, d.source_metadata as source_metadata,
             d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta, d.kind as doc_kind, d.language,
             d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos
      FROM documents d
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE d.id = ?
    `)
    this._deleteDocumentByKey = this.db.query('DELETE FROM documents WHERE key = ?')
    this._getAllTitlesForFuzzy = this.db.query('SELECT id, title FROM documents WHERE title IS NOT NULL')

    this._getFrameworkSynonyms = this.db.query(`
      SELECT alias FROM framework_synonyms WHERE canonical = ?
      UNION
      SELECT canonical FROM framework_synonyms WHERE alias = ?
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
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END), 0) as processed,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COUNT(*) as total
      FROM crawl_state
    `)

    this._getSnapshotMeta = this.db.query('SELECT value FROM snapshot_meta WHERE key = ?')
    this._setSnapshotMeta = this.db.query('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)')
    this._getSyncCheckpoint = this.db.query('SELECT value FROM sync_checkpoint WHERE key = ?')
    this._setSyncCheckpoint = this.db.query('INSERT OR REPLACE INTO sync_checkpoint (key, value, updated_at) VALUES (?, ?, ?)')
    this._clearSyncCheckpoint = this.db.query('DELETE FROM sync_checkpoint WHERE key = ?')

    this._getRenderIndexEntry = this.db.query(
      'SELECT doc_id, sections_digest, template_version, html_hash, updated_at FROM document_render_index WHERE doc_id = ?'
    )
    this._upsertRenderIndexEntry = this.db.query(
      'INSERT OR REPLACE INTO document_render_index (doc_id, sections_digest, template_version, html_hash, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    this._clearRenderIndex = this.db.query('DELETE FROM document_render_index')
  }

  upsertRoot(slug, displayName, kind, source, seedPath = null, sourceType = null) {
    const now = new Date().toISOString()
    return this._upsertRoot.get({
      $slug: slug,
      $display_name: displayName,
      $kind: kind,
      $source: source,
      $seed_path: seedPath,
      $source_type: sourceType ?? deriveRootSourceType(slug, kind),
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

  upsertDocument(params) {
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
    if (!this._deleteDocumentSections || !this._insertDocumentSection) return
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
    return this._getPage.get(path, 'active')
  }

  getPageByPath(path) {
    return this._getPage.get(path, 'active')
  }

  getActivePathsIn(keys) {
    if (!keys || keys.length === 0) return new Set()

    const activePaths = new Set()
    const chunkSize = 900

    for (let index = 0; index < keys.length; index += chunkSize) {
      const chunk = keys.slice(index, index + chunkSize)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.db.query(`
        SELECT path
        FROM pages
        WHERE status = 'active'
          AND path IN (${placeholders})
      `).all(...chunk)

      for (const row of rows) {
        activePaths.add(row.path)
      }
    }

    return activePaths
  }

  getDocumentSections(key) {
    if (!this._getDocumentSections) return []
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
    return this._getDocumentsByRoot.all(rootSlug)
  }

  searchPages(ftsQuery, rawQuery, { framework = null, kind = null, limit = 100, language = null, sourceType = null, minIos = null, minMacos = null, minWatchos = null, minTvos = null, minVisionos = null } = {}) {
    const filterParams = { $language: language, $source_type: sourceType, $min_ios: minIos, $min_macos: minMacos, $min_watchos: minWatchos, $min_tvos: minTvos, $min_visionos: minVisionos }
    const stmt = framework ? this._searchDocumentsFw : this._searchDocuments
    return stmt.all({ $query: ftsQuery, $raw: rawQuery, $framework: framework, $kind: kind, $limit: limit, ...filterParams })
  }

  searchTitleExact(rawQuery, { framework = null, kind = null, limit = 100, language = null, sourceType = null, minIos = null, minMacos = null, minWatchos = null, minTvos = null, minVisionos = null } = {}) {
    const filterParams = { $language: language, $source_type: sourceType, $min_ios: minIos, $min_macos: minMacos, $min_watchos: minWatchos, $min_tvos: minTvos, $min_visionos: minVisionos }
    const stmt = framework ? this._searchDocumentsTitleExactFw : this._searchDocumentsTitleExact
    return stmt.all({ $raw: rawQuery, $framework: framework, $kind: kind, $limit: limit, ...filterParams })
  }

  searchTrigram(query, { framework = null, kind = null, limit = 100, language = null, sourceType = null, minIos = null, minMacos = null, minWatchos = null, minTvos = null, minVisionos = null } = {}) {
    const stmt = framework ? this._searchDocumentsTrigramFw : this._searchDocumentsTrigram
    if (!stmt) return []
    const filterParams = { $language: language, $source_type: sourceType, $min_ios: minIos, $min_macos: minMacos, $min_watchos: minWatchos, $min_tvos: minTvos, $min_visionos: minVisionos }
    try {
      return stmt.all({ $query: query, $framework: framework, $kind: kind, $limit: limit, ...filterParams })
    } catch { return [] }
  }

  searchBody(ftsQuery, { framework = null, kind = null, limit = 100, language = null, sourceType = null, minIos = null, minMacos = null, minWatchos = null, minTvos = null, minVisionos = null } = {}) {
    const stmt = framework ? this._searchDocumentsBodyFw : this._searchDocumentsBody
    if (!stmt) return []
    const filterParams = { $language: language, $source_type: sourceType, $min_ios: minIos, $min_macos: minMacos, $min_watchos: minWatchos, $min_tvos: minTvos, $min_visionos: minVisionos }
    try {
      return stmt.all({ $query: ftsQuery, $framework: framework, $kind: kind, $limit: limit, ...filterParams })
    } catch { return [] }
  }

  getFrameworkSynonyms(slug) {
    if (!slug) return []
    const normalized = slug.toLowerCase()
    return this._getFrameworkSynonyms.all(normalized, normalized).map(r => r.alias ?? r.canonical)
  }

  getDocumentSnippetData(keys) {
    if (!keys || keys.length === 0) return new Map()
    const placeholders = keys.map(() => '?').join(',')
    const docs = this.db.query(`
      SELECT id, key, title, abstract_text, declaration_text, headings
      FROM documents WHERE key IN (${placeholders})
    `).all(...keys)
    const docMap = new Map()
    const idToKey = new Map()
    for (const d of docs) {
      idToKey.set(d.id, d.key)
      docMap.set(d.key, { document: d, sections: [] })
    }
    if (idToKey.size > 0 && this.hasTable('document_sections')) {
      const ids = [...idToKey.keys()]
      const sPlaceholders = ids.map(() => '?').join(',')
      const sections = this.db.query(`
        SELECT document_id, section_kind, heading, content_text, sort_order
        FROM document_sections WHERE document_id IN (${sPlaceholders})
        ORDER BY sort_order
      `).all(...ids)
      for (const s of sections) {
        const key = idToKey.get(s.document_id)
        if (key && docMap.has(key)) {
          docMap.get(key).sections.push(s)
        }
      }
    }
    return docMap
  }

  getRelatedDocCounts(keys) {
    if (!keys || keys.length === 0) return new Map()
    const placeholders = keys.map(() => '?').join(',')
    const rows = this.db.query(`
      SELECT from_key, COUNT(*) as count
      FROM document_relationships WHERE from_key IN (${placeholders})
      GROUP BY from_key
    `).all(...keys)
    const map = new Map()
    for (const r of rows) map.set(r.from_key, r.count)
    return map
  }

  getBodyIndexCount() {
    if (!this._documentsBodyIndexCount) return 0
    try { return this._documentsBodyIndexCount.get().c } catch { return 0 }
  }

  insertBody(documentId, body) {
    if (!this._insertDocumentBody) return
    this._insertDocumentBody.run({ $id: documentId, $body: body })
  }

  clearBodyIndex() {
    if (!this._clearDocumentBody) return
    this._clearDocumentBody.run()
  }

  getTrigramCandidates(trigram) {
    if (!this._documentTrigramCandidates) return []
    try {
      return this._documentTrigramCandidates.all({ $trigram: trigram })
    } catch { return [] }
  }

  getAllTitlesForFuzzy() {
    return this._getAllTitlesForFuzzy.all()
  }

  /**
   * Thin wrapper so the reader-pool can route fuzzy matching through a worker
   * by op name. Keeps the trigram/Levenshtein routine identical — only the
   * call surface changes. Off the main thread, this lets a long fuzzy scan
   * run in parallel with other search tiers rather than blocking the event
   * loop. The `_trigramCache` lives in the lib module, so each worker builds
   * its own cache once per process lifetime (cost: O(titles × avg_trigrams)).
   */
  fuzzyMatchTitles(query, opts = {}) {
    return fuzzyMatchTitles(query, this, opts)
  }

  searchByTitle(title, framework = null) {
    return this._searchDocumentByTitle.get({ $title: title, $framework: framework })
  }

  getSearchRecordById(id) {
    return this._getDocumentSearchRecordById.get(id)
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
    return this._getDocumentsByRole.all(role)
  }

  markPageDeleted(path) {
    this._markPageDeleted.run(path)
    this.deleteNormalizedDocument(path)
  }

  deleteNormalizedDocument(key) {
    const document = this._getDocumentIdByKey.get(key)
    if (!document) return false

    if (this._deleteDocumentBody) this._deleteDocumentBody.run(document.id)
    if (this._deleteDocumentSections) this._deleteDocumentSections.run(document.id)
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

  getSnapshotMeta(key) {
    const row = this._getSnapshotMeta.get(key)
    return row ? row.value : null
  }

  setSnapshotMeta(key, value) {
    this._setSnapshotMeta.run(key, String(value))
    if (key === 'snapshot_tier') {
      this._tier = undefined
    }
  }

  getSyncCheckpoint(key) {
    const row = this._getSyncCheckpoint.get(key)
    if (!row) return null
    try {
      return JSON.parse(row.value)
    } catch {
      return row.value
    }
  }

  setSyncCheckpoint(key, value) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    this._setSyncCheckpoint.run(key, serialized, new Date().toISOString())
  }

  clearSyncCheckpoint(key) {
    this._clearSyncCheckpoint.run(key)
  }

  /**
   * Singleton checkpoint for the static web build, stored in sync_checkpoint
   * under the key 'web_build'. Holds the run id, last persisted doc id,
   * counts (built/skipped/failed), and the resolved output directory so a
   * killed build can resume against the same target.
   * @returns {object|null}
   */
  getWebBuildCheckpoint() {
    return this.getSyncCheckpoint('web_build')
  }

  setWebBuildCheckpoint(state) {
    this.setSyncCheckpoint('web_build', state)
  }

  clearWebBuildCheckpoint() {
    this.clearSyncCheckpoint('web_build')
  }

  /**
   * Per-document render fingerprint used by the incremental build to skip
   * documents whose inputs (sections_digest) and template surface
   * (template_version) match the last successful render.
   * @param {number} docId
   * @returns {{ doc_id: number, sections_digest: string, template_version: string, html_hash: string, updated_at: number }|null}
   */
  getRenderIndexEntry(docId) {
    return this._getRenderIndexEntry.get(docId) ?? null
  }

  upsertRenderIndexEntry({ docId, sectionsDigest, templateVersion, htmlHash }) {
    this._upsertRenderIndexEntry.run(
      docId,
      sectionsDigest,
      templateVersion,
      htmlHash,
      Math.floor(Date.now() / 1000),
    )
  }

  clearRenderIndex() {
    this._clearRenderIndex.run()
  }

  /**
   * Return parent->child edges for a framework's document tree.
   * Each row has { from_key, to_key }.
   * @param {string} framework - The framework slug (e.g. 'documentation/swiftui')
   * @returns {Array<{from_key: string, to_key: string}>}
   */
  getFrameworkTree(framework) {
    if (!this.hasTable('document_relationships')) return []
    return this.db.query(`
      SELECT dr.from_key, dr.to_key
      FROM document_relationships dr
      JOIN documents d ON d.key = dr.from_key
      WHERE d.framework = ? AND dr.relation_type = 'child'
      ORDER BY dr.sort_order
    `).all(framework)
  }

  upsertAppleFontFamily(params) {
    const now = new Date().toISOString()
    this.db.query(`
      INSERT INTO apple_font_families (
        id, display_name, source_url, source_sha256, source_size,
        source_path, extracted_path, status, category, updated_at
      )
      VALUES (
        $id, $display_name, $source_url, $source_sha256, $source_size,
        $source_path, $extracted_path, $status, $category, $updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        source_url = COALESCE(excluded.source_url, apple_font_families.source_url),
        source_sha256 = COALESCE(excluded.source_sha256, apple_font_families.source_sha256),
        source_size = COALESCE(excluded.source_size, apple_font_families.source_size),
        source_path = COALESCE(excluded.source_path, apple_font_families.source_path),
        extracted_path = COALESCE(excluded.extracted_path, apple_font_families.extracted_path),
        status = excluded.status,
        category = COALESCE(excluded.category, apple_font_families.category),
        updated_at = excluded.updated_at
    `).run({
      $id: params.id,
      $display_name: params.displayName,
      $source_url: params.sourceUrl ?? null,
      $source_sha256: params.sourceSha256 ?? null,
      $source_size: params.sourceSize ?? null,
      $source_path: params.sourcePath ?? null,
      $extracted_path: params.extractedPath ?? null,
      $status: params.status ?? 'available',
      $category: params.category ?? null,
      $updated_at: now,
    })
  }

  upsertAppleFontFile(params) {
    const now = new Date().toISOString()
    this.db.query(`
      INSERT INTO apple_font_files (
        id, family_id, file_name, file_path, postscript_name,
        style_name, weight, variant, italic, format,
        source, is_variable, axes_json, sha256, size, updated_at
      )
      VALUES (
        $id, $family_id, $file_name, $file_path, $postscript_name,
        $style_name, $weight, $variant, $italic, $format,
        $source, $is_variable, $axes_json, $sha256, $size, $updated_at
      )
      ON CONFLICT(family_id, file_name) DO UPDATE SET
        file_path = excluded.file_path,
        postscript_name = COALESCE(excluded.postscript_name, apple_font_files.postscript_name),
        style_name = COALESCE(excluded.style_name, apple_font_files.style_name),
        weight = COALESCE(excluded.weight, apple_font_files.weight),
        variant = COALESCE(excluded.variant, apple_font_files.variant),
        italic = excluded.italic,
        format = COALESCE(excluded.format, apple_font_files.format),
        source = excluded.source,
        is_variable = excluded.is_variable,
        axes_json = COALESCE(excluded.axes_json, apple_font_files.axes_json),
        sha256 = COALESCE(excluded.sha256, apple_font_files.sha256),
        size = COALESCE(excluded.size, apple_font_files.size),
        updated_at = excluded.updated_at
    `).run({
      $id: params.id,
      $family_id: params.familyId,
      $file_name: params.fileName,
      $file_path: params.filePath,
      $postscript_name: params.postscriptName ?? null,
      $style_name: params.styleName ?? null,
      $weight: params.weight ?? null,
      $variant: params.variant ?? null,
      $italic: params.italic ? 1 : 0,
      $format: params.format ?? null,
      $source: params.source ?? 'remote',
      $is_variable: params.isVariable ? 1 : 0,
      $axes_json: params.axes ? JSON.stringify(params.axes) : null,
      $sha256: params.sha256 ?? null,
      $size: params.size ?? null,
      $updated_at: now,
    })
  }

  listAppleFonts() {
    const families = this.db.query('SELECT * FROM apple_font_families ORDER BY display_name').all()
    const files = this.db.query('SELECT * FROM apple_font_files ORDER BY family_id, file_name').all()
    const byFamily = new Map()
    for (const file of files) {
      const list = byFamily.get(file.family_id) ?? []
      list.push(normalizeAppleFontFile(file))
      byFamily.set(file.family_id, list)
    }
    return families.map(family => ({
      ...family,
      files: byFamily.get(family.id) ?? [],
    }))
  }

  getAppleFontFile(id) {
    const row = this.db.query(`
      SELECT f.*, fam.display_name as family_display_name, fam.category as family_category
      FROM apple_font_files f
      JOIN apple_font_families fam ON fam.id = f.family_id
      WHERE f.id = ?
    `).get(id)
    return row ? normalizeAppleFontFile(row) : null
  }

  upsertSfSymbol(params) {
    const now = new Date().toISOString()
    const categories = JSON.stringify(params.categories ?? [])
    const keywords = JSON.stringify(params.keywords ?? [])
    const aliases = JSON.stringify(params.aliases ?? [])
    const availability = JSON.stringify(params.availability ?? null)
    this.db.query(`
      INSERT INTO sf_symbols (
        name, scope, categories_json, keywords_json, aliases_json,
        availability_json, order_index, bundle_path, bundle_version, updated_at
      )
      VALUES (
        $name, $scope, $categories_json, $keywords_json, $aliases_json,
        $availability_json, $order_index, $bundle_path, $bundle_version, $updated_at
      )
      ON CONFLICT(scope, name) DO UPDATE SET
        categories_json = excluded.categories_json,
        keywords_json = excluded.keywords_json,
        aliases_json = excluded.aliases_json,
        availability_json = excluded.availability_json,
        order_index = excluded.order_index,
        bundle_path = excluded.bundle_path,
        bundle_version = excluded.bundle_version,
        updated_at = excluded.updated_at
    `).run({
      $name: params.name,
      $scope: params.scope,
      $categories_json: categories,
      $keywords_json: keywords,
      $aliases_json: aliases,
      $availability_json: availability,
      $order_index: params.orderIndex ?? null,
      $bundle_path: params.bundlePath ?? null,
      $bundle_version: params.bundleVersion ?? null,
      $updated_at: now,
    })
    this.db.query('DELETE FROM sf_symbols_fts WHERE rowid = (SELECT rowid FROM sf_symbols WHERE scope = ? AND name = ?)').run(params.scope, params.name)
    const rowid = this.db.query('SELECT rowid FROM sf_symbols WHERE scope = ? AND name = ?').get(params.scope, params.name)?.rowid
    if (rowid != null) {
      this.db.query('INSERT INTO sf_symbols_fts(rowid, name, keywords, categories, aliases) VALUES (?, ?, ?, ?, ?)').run(
        rowid,
        params.name,
        (params.keywords ?? []).join(' '),
        (params.categories ?? []).join(' '),
        (params.aliases ?? []).join(' '),
      )
    }
  }

  getSfSymbol(scope, name) {
    const row = this.db.query('SELECT * FROM sf_symbols WHERE scope = ? AND name = ?').get(scope, name)
    return row ? normalizeSfSymbolRow(row) : null
  }

  /**
   * Lightweight catalog of every indexed symbol — name, scope, categories,
   * keywords. Powers the /api/symbols/index.json endpoint that feeds the
   * client-side virtualized grid + search. Avoids shipping the JSON blobs
   * we don't need (availability, aliases, bundle metadata) so the gzipped
   * payload stays small even with ~10k entries.
   */
  listSfSymbolsCatalog() {
    const rows = this.db.query(`
      SELECT name, scope, categories_json, keywords_json
      FROM sf_symbols
      ORDER BY scope, COALESCE(order_index, 999999), name
    `).all()
    return rows.map(row => ({
      name: row.name,
      scope: row.scope,
      categories: parseJsonArray(row.categories_json),
      keywords: parseJsonArray(row.keywords_json),
    }))
  }

  searchSfSymbols(query = '', opts = {}) {
    const limit = Math.min(Math.max(Number.parseInt(opts.limit ?? 100, 10) || 100, 1), 500)
    const scope = opts.scope ?? null
    const q = String(query ?? '').trim()
    const parseRows = rows => rows.map(normalizeSfSymbolRow)
    if (!q) {
      return parseRows(this.db.query(`
        SELECT * FROM sf_symbols
        WHERE ($scope IS NULL OR scope = $scope)
        ORDER BY scope, COALESCE(order_index, 999999), name
        LIMIT $limit
      `).all({ $scope: scope, $limit: limit }))
    }
    try {
      return parseRows(this.db.query(`
        SELECT s.*
        FROM sf_symbols_fts f
        JOIN sf_symbols s ON s.rowid = f.rowid
        WHERE sf_symbols_fts MATCH $query
          AND ($scope IS NULL OR s.scope = $scope)
        ORDER BY bm25(sf_symbols_fts), COALESCE(s.order_index, 999999), s.name
        LIMIT $limit
      `).all({ $query: buildResourceFtsQuery(q), $scope: scope, $limit: limit }))
    } catch {
      return parseRows(this.db.query(`
        SELECT * FROM sf_symbols
        WHERE ($scope IS NULL OR scope = $scope)
          AND (
            LOWER(name) LIKE $like OR LOWER(COALESCE(keywords_json, '')) LIKE $like
            OR LOWER(COALESCE(categories_json, '')) LIKE $like
            OR LOWER(COALESCE(aliases_json, '')) LIKE $like
          )
        ORDER BY scope, COALESCE(order_index, 999999), name
        LIMIT $limit
      `).all({ $scope: scope, $like: `%${q.toLowerCase()}%`, $limit: limit }))
    }
  }

  upsertSfSymbolRender(params) {
    const now = new Date().toISOString()
    this.db.query(`
      INSERT OR REPLACE INTO sf_symbol_renders (
        cache_key, name, scope, format, mode, weight, symbol_scale,
        point_size, color, file_path, mime_type, sha256, size, updated_at
      )
      VALUES (
        $cache_key, $name, $scope, $format, $mode, $weight, $symbol_scale,
        $point_size, $color, $file_path, $mime_type, $sha256, $size, $updated_at
      )
    `).run({
      $cache_key: params.cacheKey,
      $name: params.name,
      $scope: params.scope,
      $format: params.format,
      $mode: params.mode ?? null,
      $weight: params.weight ?? null,
      $symbol_scale: params.symbolScale ?? null,
      $point_size: params.pointSize ?? null,
      $color: params.color ?? null,
      $file_path: params.filePath,
      $mime_type: params.mimeType,
      $sha256: params.sha256 ?? null,
      $size: params.size ?? null,
      $updated_at: now,
    })
  }

  getSfSymbolRender(cacheKey) {
    return this.db.query('SELECT * FROM sf_symbol_renders WHERE cache_key = ?').get(cacheKey) ?? null
  }

  getSchemaVersion() {
    const row = this.db.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()
    return row ? Number.parseInt(row.value, 10) : 0
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

function normalizeAppleFontFile(row) {
  return {
    ...row,
    italic: row.italic === 1 || row.italic === true,
    is_variable: row.is_variable === 1 || row.is_variable === true,
    axes: parseJsonArray(row.axes_json),
  }
}

function normalizeSfSymbolRow(row) {
  return {
    ...row,
    categories: parseJsonArray(row.categories_json),
    keywords: parseJsonArray(row.keywords_json),
    aliases: parseJsonArray(row.aliases_json),
    availability: parseJsonValue(row.availability_json),
  }
}

function parseJsonArray(value) {
  const parsed = parseJsonValue(value)
  return Array.isArray(parsed) ? parsed : []
}

function parseJsonValue(value) {
  if (value == null) return null
  try { return JSON.parse(value) } catch { return null }
}

function buildResourceFtsQuery(query) {
  const terms = String(query)
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/i)
    .map(term => term.trim())
    .filter(Boolean)
    .slice(0, 8)
  return terms.map(term => `"${term.replaceAll('"', '""')}"*`).join(' OR ') || '""'
}

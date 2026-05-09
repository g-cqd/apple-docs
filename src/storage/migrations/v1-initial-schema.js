/**
 * v1 — initial schema. The DDL block is the union of every migration up
 * to v13 (so a fresh DB skips straight to v13 without playing forward).
 * Subsequent migration files only carry the deltas they each introduced;
 * old corpora replay them in order.
 */

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

export function up(db) {
  db.exec(SCHEMA_SQL)
}

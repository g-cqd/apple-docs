/**
 * v10 — fonts + SF Symbols asset domain. Catalog, file inventory, full-text
 * search index, and a render cache table keyed by (renderer, params).
 */
export function up(db) {
  db.exec(`
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

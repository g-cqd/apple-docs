CREATE TABLE IF NOT EXISTS snapshot_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roots (
    slug         TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'framework',
    source_type  TEXT NOT NULL DEFAULT 'apple-docc',
    seed_path    TEXT,
    page_count   INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'active',
    index_etag   TEXT,
    last_seen    TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type      TEXT NOT NULL DEFAULT 'apple-docc',
    key              TEXT NOT NULL UNIQUE,
    title            TEXT NOT NULL,
    kind             TEXT,
    role             TEXT,
    role_heading     TEXT,
    framework        TEXT NOT NULL,
    url              TEXT,
    language         TEXT,
    usr              TEXT,
    abstract_text    TEXT,
    declaration_text TEXT,
    headings         TEXT,
    platforms_json   TEXT,
    min_ios          TEXT,
    min_macos        TEXT,
    min_watchos      TEXT,
    min_tvos         TEXT,
    min_visionos     TEXT,
    min_ios_num      INTEGER,
    min_macos_num    INTEGER,
    min_watchos_num  INTEGER,
    min_tvos_num     INTEGER,
    min_visionos_num INTEGER,
    is_deprecated    INTEGER NOT NULL DEFAULT 0,
    is_beta          INTEGER NOT NULL DEFAULT 0,
    is_release_notes INTEGER NOT NULL DEFAULT 0,
    url_depth        INTEGER NOT NULL DEFAULT 0,
    source_metadata  TEXT,
    content_hash     TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_type);
CREATE INDEX IF NOT EXISTS idx_documents_framework ON documents(framework);
CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind);
CREATE INDEX IF NOT EXISTS idx_documents_role ON documents(role);
CREATE INDEX IF NOT EXISTS idx_documents_language ON documents(language);
CREATE INDEX IF NOT EXISTS idx_documents_title_nocase ON documents(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_documents_usr ON documents(usr) WHERE usr IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_min_ios_num ON documents(min_ios_num);
CREATE INDEX IF NOT EXISTS idx_documents_min_macos_num ON documents(min_macos_num);
CREATE INDEX IF NOT EXISTS idx_documents_min_watchos_num ON documents(min_watchos_num);
CREATE INDEX IF NOT EXISTS idx_documents_min_tvos_num ON documents(min_tvos_num);
CREATE INDEX IF NOT EXISTS idx_documents_min_visionos_num ON documents(min_visionos_num);

CREATE TABLE IF NOT EXISTS document_sections (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    section_kind TEXT NOT NULL,
    heading      TEXT,
    content_text BLOB NOT NULL,
    content_json BLOB,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    UNIQUE(document_id, section_kind, sort_order)
);
CREATE INDEX IF NOT EXISTS idx_sections_doc ON document_sections(document_id);

CREATE TABLE IF NOT EXISTS document_relationships (
    from_key      TEXT NOT NULL,
    to_key        TEXT NOT NULL,
    relation_type TEXT NOT NULL DEFAULT 'reference',
    section       TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (from_key, to_key, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_rel_to ON document_relationships(to_key);

CREATE TABLE IF NOT EXISTS document_raw (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    raw         BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS document_vectors (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    vec         BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS document_chunks (
    chunk_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ord         INTEGER NOT NULL,
    text        BLOB,
    vec_bin     BLOB NOT NULL,
    vec_i8      BLOB,
    UNIQUE(document_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    title, abstract, declaration, headings, key,
    tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_trigram USING fts5(
    title,
    content='documents',
    content_rowid='id',
    tokenize='trigram case_sensitive 0'
);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_body_fts USING fts5(
    body,
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
    VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
    INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
END;

CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
    DELETE FROM documents_fts WHERE rowid = old.id;
    INSERT INTO documents_trigram(documents_trigram, rowid, title)
    VALUES ('delete', old.id, old.title);
END;

CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents
WHEN old.title IS NOT new.title
  OR old.abstract_text IS NOT new.abstract_text
  OR old.declaration_text IS NOT new.declaration_text
  OR old.headings IS NOT new.headings
  OR old.key IS NOT new.key
BEGIN
    DELETE FROM documents_fts WHERE rowid = old.id;
    INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
    VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
    INSERT INTO documents_trigram(documents_trigram, rowid, title)
    VALUES ('delete', old.id, old.title);
    INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
END;

CREATE TABLE IF NOT EXISTS apple_font_families (
    id             TEXT PRIMARY KEY,
    display_name   TEXT NOT NULL,
    source_url     TEXT,
    source_sha256  TEXT,
    source_size    INTEGER,
    category       TEXT,
    status         TEXT NOT NULL DEFAULT 'available',
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS apple_font_files (
    id              TEXT PRIMARY KEY,
    family_id       TEXT NOT NULL REFERENCES apple_font_families(id) ON DELETE CASCADE,
    file_name       TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    postscript_name TEXT,
    style_name      TEXT,
    weight          TEXT,
    variant         TEXT,
    italic          INTEGER NOT NULL DEFAULT 0,
    format          TEXT,
    source          TEXT NOT NULL DEFAULT 'remote' CHECK(source IN ('remote', 'system')),
    is_variable     INTEGER NOT NULL DEFAULT 0,
    axes_json       TEXT,
    sha256          TEXT,
    size            INTEGER,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(family_id, file_name)
);
CREATE INDEX IF NOT EXISTS idx_apple_font_files_family ON apple_font_files(family_id);

CREATE TABLE IF NOT EXISTS sf_symbols (
    name                     TEXT NOT NULL,
    scope                    TEXT NOT NULL CHECK(scope IN ('public', 'private')),
    categories_json          TEXT,
    keywords_json            TEXT,
    aliases_json             TEXT,
    availability_json        TEXT,
    order_index              INTEGER,
    codepoint                INTEGER,
    bitmap_only              INTEGER NOT NULL DEFAULT 0,
    render_unsupported       INTEGER NOT NULL DEFAULT 0,
    unsupported_variants     TEXT,
    bundle_version           TEXT,
    updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (scope, name)
);

CREATE VIRTUAL TABLE IF NOT EXISTS sf_symbols_fts USING fts5(
    name, keywords, categories, aliases,
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
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crawl_state (
    path      TEXT PRIMARY KEY,
    status    TEXT NOT NULL DEFAULT 'pending',
    root_slug TEXT NOT NULL,
    depth     INTEGER NOT NULL DEFAULT 0,
    error     TEXT
);
CREATE INDEX IF NOT EXISTS idx_crawl_root_status ON crawl_state(root_slug, status);

CREATE TABLE IF NOT EXISTS sync_checkpoint (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

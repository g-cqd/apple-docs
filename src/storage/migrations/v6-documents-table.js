/**
 * v6 — introduce the canonical documents table (multi-source-aware) plus
 * document_sections, document_relationships, snapshot_meta, and the FTS5
 * companions documents_fts / documents_trigram / documents_body_fts.
 *
 * Backfills documents from pages, and document_relationships from refs.
 * The legacy pages + refs tables stay alongside; killing them is the
 * P4 migration v14 in the remediation plan.
 */
export function up(db) {
  db.run(`CREATE TABLE IF NOT EXISTS documents (
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

  db.run('CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_type)')
  db.run('CREATE INDEX IF NOT EXISTS idx_documents_framework ON documents(framework)')
  db.run('CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind)')
  db.run('CREATE INDEX IF NOT EXISTS idx_documents_language ON documents(language)')
  db.run('CREATE INDEX IF NOT EXISTS idx_documents_key ON documents(key)')

  db.run(`CREATE TABLE IF NOT EXISTS document_sections (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    section_kind  TEXT NOT NULL,
    heading       TEXT,
    content_text  TEXT NOT NULL,
    content_json  TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    UNIQUE(document_id, section_kind, sort_order)
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_sections_doc ON document_sections(document_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_sections_kind ON document_sections(section_kind)')

  db.run(`CREATE TABLE IF NOT EXISTS document_relationships (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    from_key      TEXT NOT NULL,
    to_key        TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    section       TEXT,
    sort_order    INTEGER DEFAULT 0,
    UNIQUE(from_key, to_key, relation_type)
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_rel_from ON document_relationships(from_key)')
  db.run('CREATE INDEX IF NOT EXISTS idx_rel_to ON document_relationships(to_key)')

  db.run(`CREATE TABLE IF NOT EXISTS snapshot_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`)

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    title, abstract, declaration, headings, key,
    tokenize='porter unicode61'
  )`)
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_trigram USING fts5(
    title,
    tokenize='trigram case_sensitive 0'
  )`)
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_body_fts USING fts5(
    body,
    tokenize='porter unicode61'
  )`)

  db.run('DROP TRIGGER IF EXISTS documents_ai')
  db.run('DROP TRIGGER IF EXISTS documents_ad')
  db.run('DROP TRIGGER IF EXISTS documents_au')
  db.run(`CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
    VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
    INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
  END`)
  db.run(`CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
    DELETE FROM documents_fts WHERE rowid = old.id;
    DELETE FROM documents_trigram WHERE rowid = old.id;
  END`)
  db.run(`CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
    DELETE FROM documents_fts WHERE rowid = old.id;
    INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
    VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
    DELETE FROM documents_trigram WHERE rowid = old.id;
    INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
  END`)

  db.run(`
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

  db.run(`
    INSERT OR IGNORE INTO document_relationships (from_key, to_key, relation_type, section, sort_order)
    SELECT p.path, refs.target_path, 'reference', refs.section, 0
    FROM refs
    JOIN pages p ON p.id = refs.source_id
  `)
}

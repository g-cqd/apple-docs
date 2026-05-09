/**
 * v4 — fuzzy/title trigram + full-body FTS5 tables, plus replacement
 * triggers that mirror inserts/updates/deletes into the trigram table.
 */
export function up(db) {
  // Trigram FTS5 table for fuzzy title matching
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS titles_trigram USING fts5(
    title, content='pages', content_rowid='id',
    tokenize='trigram case_sensitive 0'
  )`)
  // Full-body FTS5 table (opt-in, populated by index command)
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS pages_body_fts USING fts5(
    body, tokenize='porter unicode61'
  )`)
  // Replace triggers to also sync titles_trigram
  db.run('DROP TRIGGER IF EXISTS pages_ai')
  db.run('DROP TRIGGER IF EXISTS pages_ad')
  db.run('DROP TRIGGER IF EXISTS pages_au')
  db.run(`CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts(rowid, title, role_heading, abstract, path, declaration)
    VALUES (new.id, new.title, new.role_heading, new.abstract, new.path, new.declaration);
    INSERT INTO titles_trigram(rowid, title) VALUES (new.id, new.title);
  END`)
  db.run(`CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, role_heading, abstract, path, declaration)
    VALUES ('delete', old.id, old.title, old.role_heading, old.abstract, old.path, old.declaration);
    INSERT INTO titles_trigram(titles_trigram, rowid, title) VALUES ('delete', old.id, old.title);
  END`)
  db.run(`CREATE TRIGGER pages_au AFTER UPDATE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, role_heading, abstract, path, declaration)
    VALUES ('delete', old.id, old.title, old.role_heading, old.abstract, old.path, old.declaration);
    INSERT INTO pages_fts(rowid, title, role_heading, abstract, path, declaration)
    VALUES (new.id, new.title, new.role_heading, new.abstract, new.path, new.declaration);
    INSERT INTO titles_trigram(titles_trigram, rowid, title) VALUES ('delete', old.id, old.title);
    INSERT INTO titles_trigram(rowid, title) VALUES (new.id, new.title);
  END`)
  // Backfill trigram table from existing pages
  db.run('INSERT INTO titles_trigram(rowid, title) SELECT id, title FROM pages WHERE title IS NOT NULL')
}

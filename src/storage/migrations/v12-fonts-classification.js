/**
 * v12 — typography classification columns + tightened apple_font_files
 * uniqueness. The unique constraint moves from (family_id, file_path) to
 * (family_id, file_name); the same physical font discovered in multiple
 * disk locations is now one row, with `source` recording which copy we
 * kept (preferring 'remote' = downloaded DMG over 'system' = /Library/Fonts).
 */
export function up(db) {
  try { db.run('ALTER TABLE apple_font_families ADD COLUMN category TEXT') } catch { /* column exists */ }
  try { db.run("ALTER TABLE apple_font_files ADD COLUMN source TEXT NOT NULL DEFAULT 'remote'") } catch { /* */ }
  try { db.run('ALTER TABLE apple_font_files ADD COLUMN is_variable INTEGER NOT NULL DEFAULT 0') } catch { /* */ }
  try { db.run('ALTER TABLE apple_font_files ADD COLUMN axes_json TEXT') } catch { /* */ }
  try { db.run('ALTER TABLE apple_font_files ADD COLUMN variant TEXT') } catch { /* */ }
  try { db.run('ALTER TABLE apple_font_files ADD COLUMN italic INTEGER NOT NULL DEFAULT 0') } catch { /* */ }
  // Drop legacy duplicates (same family + file_name across multiple disk
  // paths) before tightening the constraint. Keep the row whose path lives
  // under the user's apple-docs data dir so the cached download stays
  // canonical.
  db.run(`
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
  db.exec(`
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

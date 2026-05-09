/**
 * v5 — multi-source metadata columns on roots + pages, framework
 * synonyms table, and a backfill pass that derives source_type from
 * existing root kinds.
 */
export function up(db) {
  // Multi-source metadata columns on roots
  try { db.run("ALTER TABLE roots ADD COLUMN source_type TEXT NOT NULL DEFAULT 'apple-docc'") } catch { /* column exists */ }

  // Multi-source metadata columns on pages
  try { db.run("ALTER TABLE pages ADD COLUMN source_type TEXT NOT NULL DEFAULT 'apple-docc'") } catch { /* */ }
  try { db.run('ALTER TABLE pages ADD COLUMN language TEXT') } catch { /* */ }
  try { db.run('ALTER TABLE pages ADD COLUMN is_release_notes INTEGER DEFAULT 0') } catch { /* */ }
  try { db.run('ALTER TABLE pages ADD COLUMN url_depth INTEGER DEFAULT 0') } catch { /* */ }
  try { db.run('ALTER TABLE pages ADD COLUMN doc_kind TEXT') } catch { /* */ }
  try { db.run('ALTER TABLE pages ADD COLUMN source_metadata TEXT') } catch { /* */ }
  try { db.run('ALTER TABLE pages ADD COLUMN min_ios TEXT') } catch { /* */ }
  try { db.run('ALTER TABLE pages ADD COLUMN min_macos TEXT') } catch { /* */ }
  try { db.run('ALTER TABLE pages ADD COLUMN min_watchos TEXT') } catch { /* */ }
  try { db.run('ALTER TABLE pages ADD COLUMN min_tvos TEXT') } catch { /* */ }
  try { db.run('ALTER TABLE pages ADD COLUMN min_visionos TEXT') } catch { /* */ }

  // Framework synonyms lookup table
  db.run(`CREATE TABLE IF NOT EXISTS framework_synonyms (
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
  const insertSynonym = db.query('INSERT OR IGNORE INTO framework_synonyms (canonical, alias) VALUES (?, ?)')
  for (const [canonical, alias] of synonyms) {
    insertSynonym.run(canonical, alias)
  }

  // Backfill source_type from root kind
  db.run("UPDATE roots SET source_type = 'hig' WHERE kind = 'design'")
  db.run("UPDATE roots SET source_type = 'guidelines' WHERE slug = 'app-store-review'")
  db.run('UPDATE pages SET source_type = (SELECT r.source_type FROM roots r WHERE r.id = pages.root_id) WHERE EXISTS (SELECT 1 FROM roots r WHERE r.id = pages.root_id AND r.source_type != \'apple-docc\')')

  // Backfill computed columns
  db.run("UPDATE pages SET is_release_notes = 1 WHERE path LIKE '%/release-notes%' OR role = 'releaseNotes'")
  db.run("UPDATE pages SET url_depth = length(path) - length(replace(path, '/', ''))")
  db.run('UPDATE pages SET doc_kind = role WHERE role IS NOT NULL')
}

/** v3 — add seed_path to roots. ALTER guarded against re-run on partial DBs. */
export function up(db) {
  try { db.run('ALTER TABLE roots ADD COLUMN seed_path TEXT') } catch { /* column already exists */ }
}

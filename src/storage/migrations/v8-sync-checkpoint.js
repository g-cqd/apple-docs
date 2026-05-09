/** v8 — generic sync checkpoint table for resumable long-running ops. */
export function up(db) {
  db.run(`CREATE TABLE IF NOT EXISTS sync_checkpoint (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
}

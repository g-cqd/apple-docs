/** v2 — activity table for tracking long-running operations. */
export function up(db) {
  db.run(`CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    action     TEXT    NOT NULL,
    started_at TEXT    NOT NULL,
    pid        INTEGER NOT NULL,
    roots      TEXT
  )`)
}

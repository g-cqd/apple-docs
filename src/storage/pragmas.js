/**
 * SQLite PRAGMA setup for DocsDatabase. Extracted from the constructor in
 * P2.3 so the configuration knobs live in one inspectable place and the
 * database.js facade gets thinner.
 *
 * Run order:
 *   1. applyPragmas(db)            — WAL, mmap, cache, busy timeout, …
 *   2. (caller) runMigrations(db)  — schema setup
 *   3. enableForeignKeys(db)       — turn FK enforcement on AFTER migrations
 *      so ALTER TABLE-heavy historical migrations don't choke on legacy
 *      orphaned rows. From this point on every insert/update/delete is
 *      FK-checked. (See P1.8.)
 */

/** Apply the standard pragma set. Returns the effective mmap size in
 *  bytes (0 when the platform's bun:sqlite build caps mmap below the
 *  requested 10 GB — surfaces via DocsDatabase.getEffectiveMmapSize()). */
export function applyPragmas(db) {
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA cache_size = -64000')
  db.run('PRAGMA temp_store = MEMORY')
  db.run('PRAGMA busy_timeout = 5000')
  // 10 GB virtual address space for memory-mapped I/O. SQLite caps this at
  // both the compiled SQLITE_MAX_MMAP_SIZE and the actual DB file size, so
  // a small corpus simply maps the whole file. Pages are demand-paged via
  // the OS unified page cache — no physical RAM is reserved up front.
  // Biggest win is on FTS5 index scans: zero syscalls and no double-buffer
  // through SQLite's page cache.
  db.run('PRAGMA mmap_size = 10737418240')
  // Write-side: let the WAL grow to ~8 MB (with 4 KB pages) before
  // auto-checkpointing. Reduces checkpoint churn during `apple-docs
  // update` without affecting concurrent readers under WAL.
  db.run('PRAGMA wal_autocheckpoint = 2000')
  // Read back the effective mmap size — diagnostic surface for operators
  // running on a Bun build that caps lower than requested.
  try {
    const row = db.query('PRAGMA mmap_size').get()
    return row ? Number(row.mmap_size ?? Object.values(row)[0] ?? 0) : 0
  } catch {
    return 0
  }
}

/** Turn FK enforcement on. Idempotent. Call AFTER runMigrations. */
export function enableForeignKeys(db) {
  db.run('PRAGMA foreign_keys = ON')
}

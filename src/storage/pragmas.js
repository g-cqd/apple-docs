/**
 * SQLite PRAGMA setup for DocsDatabase. Keeps the configuration knobs in
 * one inspectable place.
 *
 * Run order:
 *   1. applyPragmas(db)            — WAL, mmap, cache, busy timeout, …
 *   2. (caller) runMigrations(db)  — schema setup
 *   3. enableForeignKeys(db)       — turn FK enforcement on AFTER migrations
 *      so ALTER TABLE-heavy historical migrations don't choke on legacy
 *      orphaned rows. From this point on every insert/update/delete is
 *      FK-checked.
 */

/** Apply the standard pragma set. Returns the effective mmap size in
 *  bytes (0 when the platform's bun:sqlite build caps mmap below the
 *  requested 10 GB — surfaces via DocsDatabase.getEffectiveMmapSize()). */
/** @param {import('bun:sqlite').Database} db */
export function applyPragmas(db) {
  // busy_timeout FIRST: `journal_mode = WAL` is a write that needs the
  // lock — with the timeout set after it, a concurrent first boot
  // (web + MCP starting together) threw "database is locked" instantly.
  db.run('PRAGMA busy_timeout = 5000')
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA cache_size = -64000')
  db.run('PRAGMA temp_store = MEMORY')
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
/** @param {import('bun:sqlite').Database} db */
export function enableForeignKeys(db) {
  db.run('PRAGMA foreign_keys = ON')
}

/**
 * Run `fn` with `temp_store = FILE`, restoring MEMORY afterwards (even on
 * throw). VACUUM builds its transient copy in temp storage; under the
 * global MEMORY setting a multi-GB database VACUUM allocates that copy in
 * RAM — which OOM-killed a first install inside a 6 GB Linux VM. FILE
 * keeps the temp b-tree on disk for the duration of the maintenance
 * operation only; query-time temp behavior is unaffected.
 */
/** @param {import('bun:sqlite').Database} db @param {() => any} fn */
export function withFileTempStore(db, fn) {
  db.run('PRAGMA temp_store = FILE')
  try {
    return fn()
  } finally {
    db.run('PRAGMA temp_store = MEMORY')
  }
}

const BUSY_RE = /database is locked|SQLITE_BUSY/i

/**
 * Retry `fn` on SQLITE_BUSY with linear backoff inside a time budget.
 * Boot-path helper: a sibling process running the full fresh-corpus
 * migration can hold the write lock well past `busy_timeout`; callers
 * must be idempotent (pragmas and the migration runner both are).
 */
/** @param {() => any} fn @param {{ budgetMs?: number }} [opts] */
export function withBusyRetry(fn, { budgetMs = 30_000 } = {}) {
  const deadline = Date.now() + budgetMs
  for (let attempt = 0; ; attempt++) {
    try {
      return fn()
    } catch (e) {
      if (!BUSY_RE.test(String(e instanceof Error ? e.message : e)) || Date.now() >= deadline) throw e
      Bun.sleepSync(Math.min(250 * (attempt + 1), 2000))
    }
  }
}

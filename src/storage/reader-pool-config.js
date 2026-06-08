/**
 * Pool sizing + per-op deadline configuration for the reader pool. Split out
 * of reader-pool.js to keep that file under the 400-line ceiling.
 */

import { availableParallelism } from 'node:os'

const DEFAULT_MAX_WORKERS = 12
const FALLBACK_SIZE = 6

/**
 * Hardware-aware default worker count: `availableParallelism() - 2`, clamped
 * to [2, DEFAULT_MAX_WORKERS] so a 96-core host doesn't spawn absurd numbers
 * of SQLite handles and a 1-2 core host still gets a usable pool.
 */
export function resolveDefaultSize() {
  try {
    const hw = availableParallelism?.() ?? FALLBACK_SIZE
    return Math.min(DEFAULT_MAX_WORKERS, Math.max(2, hw - 2))
  } catch {
    return FALLBACK_SIZE
  }
}

export const DEFAULT_MAX_PENDING_PER_WORKER = 64
export const DEFAULT_DEADLINE_MS = 5_000
// Bounded worker-boot retries. A worker's first DB open runs
// `PRAGMA journal_mode = WAL` (src/storage/pragmas.js) — a write that brings
// up the shared -wal/-shm. When sibling connections bring it up concurrently
// the open can transiently throw SQLITE_NOTADB / SQLITE_IOERR, error classes
// that busy_timeout does NOT cover. Respawning after a short backoff lets the
// race clear, so a transient miss self-heals instead of disabling the whole
// pool (the main-thread fallback already proves the DB file is valid).
export const DEFAULT_BOOT_RETRIES = 3

// Per-op deadline overrides. Resolution: opts.deadlineMs > this
// map > pool default > DEFAULT_DEADLINE_MS. Strict ops cap above warm-
// cache p99 but below the bench HEAVY budget; deep ops have honest
// multi-second tails that the strict/deep pool split keeps off strict
// slots.
export const PER_OP_DEADLINE_MS = Object.freeze({
  searchTitleExact: 750,
  searchTrigram: 1_000,
  searchPages: 1_500,
  fuzzyMatchTitles: 2_000,
  searchBody: 4_000,
  searchBodyAndEnrich: 4_500,
  getBodyIndexCount: 1_000,
})

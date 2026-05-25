// Thin routing helper for the SQLite reader pool.
//
// Lives in its own module so `src/storage/reader-pool.js` can stay
// under the 400-line ceiling. Importing `runRead` from
// `'../storage/reader-pool.js'` still works — the parent re-exports.

import { AssertionError } from '../lib/errors.js'

/**
 * Thin routing helper: when `ctx.readerPool` is present, dispatches `op` to a
 * worker; otherwise calls `ctx.db[op](...args)` directly. Always returns a
 * Promise so callsites have a uniform `await` shape regardless of whether
 * the pool is enabled.
 *
 * Intentionally minimal — it exists so command modules don't need to know
 * about the pool's existence beyond whether to `await`.
 */
export async function runRead(ctx, op, args = []) {
  if (ctx?.readerPool) return ctx.readerPool.run(op, args)
  const fn = ctx?.db?.[op]
  if (typeof fn !== 'function') {
    throw new AssertionError(`runRead: ctx.db has no method ${op}`)
  }
  return fn.apply(ctx.db, args)
}

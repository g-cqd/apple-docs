/**
 * Shared ambient types for the JS codebase (consumed via `import('../types.js').X` in JSDoc).
 *
 * These alias the cross-module shapes that many modules pass around — the logger, the storage
 * handle, the sync progress callback — so dependents reference one name instead of re-deriving
 * each shape, and there is a single place to tighten as the provider modules are fully typed
 * under the checkJs burndown.
 *
 * @typedef {import('./lib/logger.js').Logger} Logger
 *   Structured logger (see `lib/logger.js`).
 * @typedef {any} Db
 *   The SQLite-backed storage handle (see `storage/database.js`). Aliased to `any` until
 *   storage is type-checked: referencing the quarantined `DocsDatabase` class surfaces its
 *   default-inferred (too-narrow) method signatures as false call-site errors. Flip this one
 *   line to `import('./storage/database.js').DocsDatabase` when storage joins the burndown.
 * @typedef {(event: Record<string, any>) => void} ProgressCallback
 *   Sync/build progress sink; the event object's fields vary by caller.
 */

export {}

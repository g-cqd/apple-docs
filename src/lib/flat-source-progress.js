/**
 * @param {import('../types.js').Db} db
 * @param {string} rootSlug
 * @param {Iterable<string>} keys
 * @param {Iterable<string>} [processedKeys]
 */
export function seedFlatSourceProgress(db, rootSlug, keys, processedKeys = []) {
  const processed = processedKeys instanceof Set ? processedKeys : new Set(processedKeys)
  db.tx(() => {
    db.clearCrawlState(rootSlug)
    for (const key of keys) {
      db.setCrawlState(key, processed.has(key) ? 'processed' : 'pending', rootSlug, 0)
    }
  })
}

/**
 * @param {import('../types.js').Db} db
 * @param {string} rootSlug
 * @param {string} key
 */
export function markFlatSourceProcessed(db, rootSlug, key) {
  db.setCrawlState(key, 'processed', rootSlug, 0)
}

/**
 * @param {import('../types.js').Db} db
 * @param {string} rootSlug
 * @param {string} key
 * @param {string | null} [error]
 */
export function markFlatSourceFailed(db, rootSlug, key, error = null) {
  db.setCrawlState(key, 'failed', rootSlug, 0, error)
}

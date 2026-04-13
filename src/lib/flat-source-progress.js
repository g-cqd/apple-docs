export function seedFlatSourceProgress(db, rootSlug, keys, processedKeys = []) {
  const processed = processedKeys instanceof Set ? processedKeys : new Set(processedKeys)
  db.clearCrawlState(rootSlug)
  for (const key of keys) {
    db.setCrawlState(key, processed.has(key) ? 'processed' : 'pending', rootSlug, 0)
  }
}

export function markFlatSourceProcessed(db, rootSlug, key) {
  db.setCrawlState(key, 'processed', rootSlug, 0)
}

export function markFlatSourceFailed(db, rootSlug, key, error = null) {
  db.setCrawlState(key, 'failed', rootSlug, 0, error)
}

/**
 * N=3 consecutive 404s before tombstoning a page.
 *
 * Audit 5 §4.3 flagged that a single 404 from upstream caused immediate
 * `markPageDeleted`. Apple's CDN occasionally serves transient 404s
 * (region-specific routing, content rotation, edge cache miss races).
 * Requiring a streak rules out the flap class without losing genuine
 * removals: a real removal stays 404 forever, so it tombstones in three
 * crawl cycles. The counter resets on any successful check.
 *
 * The threshold is policy-level; if it ever needs to vary by source
 * type, this module owns the table.
 */
const CONSECUTIVE_404_THRESHOLD = 3

/**
 * Increment the page's 404 streak. Tombstone only when the streak
 * reaches the threshold; otherwise log and return false so the caller
 * can leave the page active for another cycle.
 *
 * @returns {boolean} true if the page was tombstoned this call.
 */
export function gateAndTombstone404(db, path, logger) {
  const count = db.bumpConsecutive404(path)
  if (count >= CONSECUTIVE_404_THRESHOLD) {
    db.markPageDeleted(path)
    return true
  }
  logger?.info?.(`404 for ${path} (${count}/${CONSECUTIVE_404_THRESHOLD}); deferring tombstone`)
  return false
}

/**
 * Reset the streak. Called on `'unchanged'` and `'modified'` outcomes
 * so a transient 404 between successful checks doesn't carry forward.
 */
export function clearTombstoneCounter(db, path) {
  db.resetConsecutive404(path)
}

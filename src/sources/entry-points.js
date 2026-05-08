/**
 * Cross-source entry-point registry.
 *
 * Each adapter that owns archive-style content can declare entry points (see
 * `base.js#EntryPoint`) and push them via `addEntryPoints` at module load.
 * Other adapters or pipeline stages query `getEntryPointsForParent(key)` to
 * discover what to link from a given page — without any source needing to
 * know about its peers.
 *
 * Push-based by design to avoid a registry-import cycle: the registry imports
 * adapters, so adapters cannot synchronously query the registry.
 */

/** @type {import('./base.js').EntryPoint[]} */
const ENTRY_POINTS = []

/**
 * Register entry points contributed by an adapter. Safe to call multiple times;
 * duplicates (same key + same parent) are deduplicated.
 * @param {import('./base.js').EntryPoint[]} entries
 */
export function addEntryPoints(entries) {
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    if (!entry?.key || !Array.isArray(entry.parents) || entry.parents.length === 0) continue
    if (ENTRY_POINTS.some(existing =>
      existing.key === entry.key &&
      existing.parents.every(p => entry.parents.includes(p)) &&
      entry.parents.every(p => existing.parents.includes(p)),
    )) continue
    ENTRY_POINTS.push(entry)
  }
}

/** Test/diagnostic helper: clear the registry. */
export function clearEntryPoints() {
  ENTRY_POINTS.length = 0
}

/** Return all entry points whose `parents` includes the given key. */
export function getEntryPointsForParent(parentKey) {
  return ENTRY_POINTS.filter(ep => ep.parents.includes(parentKey))
}

/** Return the full registered list (read-only view). */
export function getAllEntryPoints() {
  return ENTRY_POINTS.slice()
}

/**
 * Shared render-time lookup caches for web page generation.
 *
 * P3.9 closure: the audit (deep-exhaustive §3.1) recommended replacing
 * the triple-index with on-demand prepared SELECTs against the DB. After
 * measurement that turned out to be the wrong tradeoff:
 *
 *   - Memory cost at full corpus (~350 K docs) is ~17 MB total across the
 *     three Maps + Set, not the audit's estimated 100-200 MB. Doesn't
 *     register against the production envelope (64 GB RAM available).
 *   - The cost CPU pays (per-doc DB round trips for ancestor titles +
 *     role headings) would scale build-time poorly: 350 K renders × ~6
 *     ancestor lookups × ~10 µs = ~21 s of pure SQL on a path that
 *     currently does the work in O(N) once and O(1) thereafter.
 *
 * The audit's actual cliff was the GLOBAL invalidate() that wiped the
 * triple-index on every on-demand doc fetch. P3.2 replaced that with the
 * per-key addDocument() patch path, which keeps the cache warm across
 * fetches. Memory was a red herring; staleness was the real bug.
 *
 * @param {import('../storage/database.js').DocsDatabase} db
 */
export function createWebRenderCache(db) {
  let knownKeys = null
  let ancestorTitleIndex = null
  let roleHeadingIndex = null

  function getKnownKeys() {
    if (!knownKeys) {
      knownKeys = new Set(db.db.query('SELECT key FROM documents').all().map(row => row.key))
    }
    return knownKeys
  }

  function getAncestorTitleIndex() {
    if (!ancestorTitleIndex) {
      ancestorTitleIndex = new Map()
      for (const row of db.db.query('SELECT key, title FROM documents WHERE title IS NOT NULL').all()) {
        ancestorTitleIndex.set(row.key, row.title)
      }
    }
    return ancestorTitleIndex
  }

  function getRoleHeadingIndex() {
    if (!roleHeadingIndex) {
      roleHeadingIndex = new Map()
      for (const row of db.db.query('SELECT key, role_heading FROM documents WHERE role_heading IS NOT NULL').all()) {
        roleHeadingIndex.set(row.key, row.role_heading)
      }
    }
    return roleHeadingIndex
  }

  return {
    getKnownKeys,
    getAncestorTitles(key) {
      const titles = new Map()
      if (!key) return titles

      const segs = key.split('/').filter(Boolean)
      const index = getAncestorTitleIndex()
      for (let i = 1; i < segs.length - 1; i++) {
        const partialKey = segs.slice(0, i + 1).join('/')
        const title = index.get(partialKey)
        if (title) titles.set(partialKey, title)
      }
      return titles
    },
    getRoleHeadings(keys) {
      const headings = new Map()
      if (!Array.isArray(keys) || keys.length === 0) return headings

      const index = getRoleHeadingIndex()
      for (const key of keys) {
        const roleHeading = index.get(key)
        if (roleHeading) headings.set(key, roleHeading)
      }
      return headings
    },
    /**
     * P3.2: incremental upsert. The audit flagged the global invalidate as
     * a UX cliff — every on-demand doc fetch wiped the triple-index for
     * everyone (~100-200 MB rebuild on the next request). When we know
     * which doc was just persisted we can patch the indexes in place
     * rather than throwing them away.
     *
     * No-ops when the indexes haven't been built yet (the first request
     * builds them; until then there's nothing to patch).
     *
     * @param {{ key: string, title?: string|null, roleHeading?: string|null }} entry
     */
    addDocument(entry) {
      const key = entry?.key
      if (!key) return
      if (knownKeys) knownKeys.add(key)
      if (ancestorTitleIndex && entry.title) ancestorTitleIndex.set(key, entry.title)
      if (roleHeadingIndex && entry.roleHeading) roleHeadingIndex.set(key, entry.roleHeading)
    },
    invalidate() {
      knownKeys = null
      ancestorTitleIndex = null
      roleHeadingIndex = null
    },
  }
}

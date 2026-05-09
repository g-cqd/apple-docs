/**
 * Shared render-time lookup caches for web page generation.
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

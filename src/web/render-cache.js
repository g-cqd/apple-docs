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
    invalidate() {
      knownKeys = null
      ancestorTitleIndex = null
      roleHeadingIndex = null
    },
  }
}

/**
 * Create a small bounded least-recently-used cache.
 * @param {{ max: number }} opts
 */
export function createLru(opts) {
  const max = Math.max(0, Number(opts?.max ?? 0))
  const entries = new Map()

  return {
    get(key) {
      if (!entries.has(key)) return undefined
      const value = entries.get(key)
      entries.delete(key)
      entries.set(key, value)
      return value
    },

    set(key, value) {
      if (max === 0) return value

      if (entries.has(key)) entries.delete(key)
      entries.set(key, value)

      if (entries.size > max) {
        const oldestKey = entries.keys().next().value
        entries.delete(oldestKey)
      }

      return value
    },

    get size() {
      return entries.size
    },
  }
}

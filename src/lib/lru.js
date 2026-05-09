/**
 * Create a small bounded least-recently-used cache.
 *
 * @param {{ max?: number, maxBytes?: number, sizeFn?: (value: unknown) => number }} opts
 *   max:     Cap on entry count. 0 disables the cache (set() is a no-op).
 *   maxBytes: Cap on total estimated bytes (A20). When set, evictions also
 *             trigger when the running byte total exceeds the cap.
 *   sizeFn:  Per-value byte estimator. Defaults to a JSON.stringify length
 *            heuristic — fine for the search-result payloads this caches.
 */
export function createLru(opts) {
  const max = Math.max(0, Number(opts?.max ?? 0))
  const maxBytes = Math.max(0, Number(opts?.maxBytes ?? 0))
  const sizeFn = typeof opts?.sizeFn === 'function' ? opts.sizeFn : defaultByteSize
  const entries = new Map()
  const sizes = new Map()
  let totalBytes = 0

  function evictOldest() {
    const oldestKey = entries.keys().next().value
    if (oldestKey === undefined) return
    entries.delete(oldestKey)
    const sz = sizes.get(oldestKey) ?? 0
    sizes.delete(oldestKey)
    totalBytes = Math.max(0, totalBytes - sz)
  }

  return {
    get(key) {
      if (!entries.has(key)) return undefined
      const value = entries.get(key)
      // LRU touch — re-insert moves to end.
      entries.delete(key)
      entries.set(key, value)
      return value
    },

    set(key, value) {
      if (max === 0) return value

      if (entries.has(key)) {
        const prevSize = sizes.get(key) ?? 0
        totalBytes = Math.max(0, totalBytes - prevSize)
        entries.delete(key)
        sizes.delete(key)
      }
      entries.set(key, value)
      const sz = maxBytes > 0 ? sizeFn(value) : 0
      if (maxBytes > 0) {
        sizes.set(key, sz)
        totalBytes += sz
      }

      while (entries.size > max) evictOldest()
      while (maxBytes > 0 && totalBytes > maxBytes && entries.size > 0) {
        evictOldest()
      }

      return value
    },

    get size() {
      return entries.size
    },

    /** Test-only / observability: estimated total bytes held. */
    get bytes() {
      return totalBytes
    },

    clear() {
      entries.clear()
      sizes.clear()
      totalBytes = 0
    },
  }
}

function defaultByteSize(value) {
  if (value == null) return 0
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

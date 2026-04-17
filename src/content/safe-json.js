import { createLru } from '../lib/lru.js'

const parsedJsonCache = createLru({ max: 2000 })

/**
 * Parse and memoize JSON strings used by content renderers.
 * Parsed arrays and objects are deep-frozen so cached references stay immutable.
 * @param {unknown} value
 * @returns {unknown}
 */
export function safeJson(value) {
  if (!value || typeof value !== 'string') return value ?? null

  const cached = parsedJsonCache.get(value)
  if (cached !== undefined) return cached

  try {
    return parsedJsonCache.set(value, freezeJsonValue(JSON.parse(value)))
  } catch {
    return parsedJsonCache.set(value, null)
  }
}

function freezeJsonValue(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value

  if (Array.isArray(value)) {
    for (const item of value) freezeJsonValue(item)
    return Object.freeze(value)
  }

  for (const nestedValue of Object.values(value)) {
    freezeJsonValue(nestedValue)
  }
  return Object.freeze(value)
}

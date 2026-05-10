import { ParseError } from '../lib/errors.js'
import { createLru } from '../lib/lru.js'

const FREEZE_MAX_DEPTH = 64

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

/**
 * Iterative deep freeze with bounded depth.
 *
 * A recursive walk would blow the JS stack on adversarial JSON (arrays
 * nested >10k deep) and wouldn't surface the depth violation as a typed
 * error. The explicit work stack here caps at FREEZE_MAX_DEPTH so a
 * malicious payload cannot exhaust resources before throwing.
 */
function freezeJsonValue(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value

  // Each frame is [container, currentDepth]. We walk depth-first, freezing
  // children before their parent so the final Object.freeze on the root sees
  // an already-frozen subtree.
  const stack = [[value, 0]]
  const toFreeze = []
  while (stack.length > 0) {
    const [node, depth] = stack.pop()
    if (!node || typeof node !== 'object' || Object.isFrozen(node)) continue
    if (depth > FREEZE_MAX_DEPTH) {
      throw new ParseError(`JSON value exceeds max freeze depth (${FREEZE_MAX_DEPTH})`, { source: 'safe-json' })
    }
    toFreeze.push(node)
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object') stack.push([item, depth + 1])
      }
    } else {
      for (const child of Object.values(node)) {
        if (child && typeof child === 'object') stack.push([child, depth + 1])
      }
    }
  }
  // Freeze in reverse-discovery order so children are frozen before parents.
  for (let i = toFreeze.length - 1; i >= 0; i--) Object.freeze(toFreeze[i])
  return value
}

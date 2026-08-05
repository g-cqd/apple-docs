/**
 * validateStorageKey is the path-traversal guard for every on-disk corpus
 * key. keyPath() calls it before resolving a key into `raw-json/` or
 * `markdown/`, so a key that survives validation and still escapes is a
 * write-anywhere primitive.
 *
 * The oracle is not "does it throw" — it is "if it ACCEPTS, is the key
 * actually safe". Rejection is always fine; acceptance is what we check.
 */

import { ValidationError } from '../src/lib/errors.js'
import { validateStorageKey } from '../src/lib/safe-path.js'

/** Properties that must hold for every key validateStorageKey returns. */
function assertKeyCannotTraverse(key) {
  if (key.startsWith('/') || key.startsWith('~')) {
    throw new Error(`accepted an absolute key: ${JSON.stringify(key)}`)
  }
  if (/^[A-Za-z]:[\\/]/.test(key)) {
    throw new Error(`accepted a Windows-rooted key: ${JSON.stringify(key)}`)
  }
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`accepted a traversing segment ${JSON.stringify(segment)} in ${JSON.stringify(key)}`)
    }
    if (segment.includes('\\') || segment.includes('\0')) {
      throw new Error(`accepted a smuggling character in ${JSON.stringify(key)}`)
    }
  }
}

export function fuzz(data) {
  const raw = data.toString('utf8')
  let accepted
  try {
    accepted = validateStorageKey(raw)
  } catch (err) {
    // Rejection is a correct outcome for anything unsafe. Only a rejection
    // that isn't our typed error indicates a real defect (a TypeError from
    // an unhandled shape, say).
    if (err instanceof ValidationError) return
    throw err
  }
  if (accepted !== raw) {
    throw new Error(`validateStorageKey mutated its input: ${JSON.stringify(raw)} -> ${JSON.stringify(accepted)}`)
  }
  assertKeyCannotTraverse(accepted)
}

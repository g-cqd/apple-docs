// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * Opt-in corpus scoping (issue #7).
 *
 * A `scope.json` at the root of the data directory narrows what `sync`
 * refreshes and what `prune` keeps — for users who want a few frameworks
 * and a couple of sources instead of the full ~350k-page corpus. The file
 * travels with the corpus, so every command sees the same scope.
 *
 *   {
 *     "version": 1,
 *     "sources": ["apple-docc", "hig", "swift-book"],
 *     "appleDoccFrameworks": ["swiftui", "combine"],
 *     "keepFonts": true,
 *     "keepSymbols": false
 *   }
 *
 * Every field except `version` is optional. `sources` omitted → all
 * sources; `appleDoccFrameworks` omitted → every apple-docc framework;
 * `keepFonts`/`keepSymbols` default to true. No `scope.json` at all →
 * `loadScope` returns null and every caller behaves exactly as today —
 * full coverage is and stays the default.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAdapterTypes } from '../sources/registry.js'
import { ValidationError } from './errors.js'

export const SCOPE_FILE = 'scope.json'

/**
 * Load and validate `<dataDir>/scope.json`. Absent file → null (the
 * hard-required "no scope, no behavior change" contract).
 *
 * @param {string} dataDir
 * @param {{ logger?: object }} [opts]
 * @returns {{ sources: string[]|null, appleDoccFrameworks: string[]|null, keepFonts: boolean, keepSymbols: boolean } | null}
 */
export function loadScope(dataDir, { logger } = {}) {
  const path = join(dataDir, SCOPE_FILE)
  if (!existsSync(path)) return null
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ValidationError(`${path} is not valid JSON: ${err.message}`)
  }
  const scope = normalizeScope(raw, path)
  logger?.info?.(
    `Scope active (${SCOPE_FILE}): sources=${scope.sources ? scope.sources.join(',') : 'all'}` +
      (scope.appleDoccFrameworks ? `; apple-docc=[${scope.appleDoccFrameworks.join(',')}]` : '') +
      `; fonts=${scope.keepFonts ? 'keep' : 'drop'}; symbols=${scope.keepSymbols ? 'keep' : 'drop'}`,
  )
  return scope
}

function normalizeScope(raw, path) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(`${path}: expected a JSON object`)
  }
  if (raw.version !== 1) {
    throw new ValidationError(`${path}: unsupported version ${JSON.stringify(raw.version)} (expected 1)`)
  }
  const sources = normalizeStringList(raw.sources, 'sources', path)
  if (sources) {
    const known = new Set(getAdapterTypes())
    const unknown = sources.filter((s) => !known.has(s))
    if (unknown.length > 0) {
      throw new ValidationError(`${path}: unknown source(s): ${unknown.join(', ')} (valid: ${[...known].sort().join(', ')})`)
    }
  }
  const frameworks = normalizeStringList(raw.appleDoccFrameworks, 'appleDoccFrameworks', path)
  if (frameworks && sources && !sources.includes('apple-docc')) {
    throw new ValidationError(`${path}: appleDoccFrameworks is set but "apple-docc" is not in sources`)
  }
  return {
    sources,
    appleDoccFrameworks: frameworks,
    keepFonts: raw.keepFonts !== false,
    keepSymbols: raw.keepSymbols !== false,
  }
}

function normalizeStringList(value, field, path) {
  if (value == null) return null
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    throw new ValidationError(`${path}: ${field} must be an array of strings`)
  }
  const list = [...new Set(value.map((x) => x.trim().toLowerCase()).filter(Boolean))]
  return list.length > 0 ? list : null
}

/**
 * Drop adapters whose source type is out of scope. No scope (or no
 * `sources` restriction) → the input list unchanged.
 */
export function filterAdaptersByScope(adapters, scope) {
  if (!scope?.sources) return adapters
  const wanted = new Set(scope.sources)
  return adapters.filter((a) => wanted.has(a.constructor.type))
}

/**
 * Per-adapter root allow-list. The `appleDoccFrameworks` narrowing applies
 * ONLY to the apple-docc adapter — other adapters' root slugs (wwdc,
 * swift-book, …) live in a different namespace and must never be filtered
 * by a framework list. Null = no restriction.
 */
export function scopeRootsFor(adapter, scope) {
  if (!scope) return null
  if (adapter.constructor.type !== 'apple-docc') return null
  return scope.appleDoccFrameworks
}

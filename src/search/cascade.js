/**
 * Search cascade: the four query variants (FTS5 / title-exact / trigram /
 * body) wrapped with safeCall + warn-once logging, plus the three-step
 * relaxation pass for natural-language phrase queries that produced no
 * results from the strict cascade.
 *
 * Each runner is a pure async function; the orchestrator in
 * commands/search.js wires them up with the per-query state.
 */

import { safeCall } from '../lib/safe-call.js'
import { runRead, DeadlineError } from '../storage/reader-pool.js'
import { pickHighSignalToken, pruneStopwords, tokenize } from './relaxation.js'
import { buildFtsQuery } from './fts-query-builder.js'

/** Build the four cascade runners bound to the current query state. */
export function buildCascadeRunners({ ctx, q, ftsQuery, frameworks, filterOpts, hasBody }) {
  const runFts = async () => {
    const flat = await safeCall(
      async () => (await Promise.all(
        frameworks.map(fw => runRead(ctx, 'searchPages', [ftsQuery, q, { ...filterOpts, framework: fw }])),
      )).flat(),
      { default: null, log: 'warn-once', label: 'search.cascade.fts' },
    )
    if (flat !== null) return flat
    // FTS5 parser error on the user's quoted query — retry with a sanitized
    // simple-prefix variant before giving up.
    const simple = `"${q.replace(/"/g, '')}"*`
    return await safeCall(
      async () => (await Promise.all(
        frameworks.map(fw => runRead(ctx, 'searchPages', [simple, q, { ...filterOpts, framework: fw }])),
      )).flat(),
      { default: [], log: 'warn-once', label: 'search.cascade.fts.fallback' },
    )
  }

  const runTitleExact = async () => {
    if (!ctx.readerPool && typeof ctx.db?.searchTitleExact !== 'function') return []
    return await safeCall(
      async () => (await Promise.all(
        frameworks.map(fw => runRead(ctx, 'searchTitleExact', [q, { ...filterOpts, framework: fw }])),
      )).flat(),
      { default: [], log: 'warn-once', label: 'search.cascade.titleExact' },
    )
  }

  const runTrigram = async () => {
    if (q.length < 3) return []
    return await safeCall(
      async () => (await Promise.all(
        frameworks.map(fw => runRead(ctx, 'searchTrigram', [q, { ...filterOpts, framework: fw }])),
      )).flat(),
      { default: [], log: 'warn-once', label: 'search.cascade.trigram' },
    )
  }

  /**
   * Body FTS runner. Distinct error semantics from the cheaper runners:
   * a deadline expiration here is *expected* under load (deep pool is
   * intentionally small) and the orchestrator surfaces it as a
   * `partial: true` flag rather than swallowing it. Other errors fall
   * through to the safeCall warn-once path and return [].
   */
  const runBody = async () => {
    if (!hasBody) return []
    return await safeCall(
      async () => (await Promise.all(
        frameworks.map(fw => runRead(ctx, 'searchBody', [ftsQuery, { ...filterOpts, framework: fw }])),
      )).flat(),
      { default: [], log: 'warn-once', label: 'search.cascade.body', passThrough: DeadlineError },
    )
  }

  return { runFts, runTitleExact, runTrigram, runBody }
}

/**
 * Three-step relaxation cascade for queries that returned no results from
 * the strict tiers. Mutates `state` (results, addResults closure) and
 * returns the relaxation-tier label that produced any hits, or null.
 *
 * @param {object} state — { ctx, q, frameworks, filterOpts, results, addResults }
 * @returns {Promise<'pruned'|'pruned-or'|'trigram'|null>}
 */
export async function runRelaxationCascade(state) {
  const { ctx, q, frameworks, filterOpts, results, addResults } = state
  if (results.length > 0 || q.length < 4 || q.includes('"')) return null

  const tokens = tokenize(q)
  if (tokens.length < 3) return null

  const pruned = pruneStopwords(tokens)
  let relaxationTier = null

  // R1 — pruned AND: keep only high-signal tokens and re-run FTS5.
  if (pruned.length >= 1) {
    const prunedQuery = buildFtsQuery(pruned.join(' '))
    const r1 = await safeCall(
      async () => (await Promise.all(
        frameworks.map(fw => runRead(ctx, 'searchPages', [prunedQuery, q, { ...filterOpts, framework: fw }])),
      )).flat(),
      { default: [], log: 'warn-once', label: 'search.relax.pruned' },
    )
    const before = results.length
    addResults(r1, 'relaxed')
    if (results.length > before) relaxationTier = 'pruned'
  }

  // R2 — pruned OR: join the pruned tokens with OR so any single hit wins.
  if (results.length === 0 && pruned.length >= 2) {
    const orQuery = pruned.map(t => `"${t.toLowerCase().replace(/"/g, '')}"`).join(' OR ')
    const r2 = await safeCall(
      async () => (await Promise.all(
        frameworks.map(fw => runRead(ctx, 'searchPages', [orQuery, q, { ...filterOpts, framework: fw }])),
      )).flat(),
      { default: [], log: 'warn-once', label: 'search.relax.prunedOr' },
    )
    const before = results.length
    addResults(r2, 'relaxed-or')
    if (results.length > before) relaxationTier = 'pruned-or'
  }

  // R3 — trigram on a single high-signal token. Prefer a CamelCase token
  // so `NavigationStack` still drives the lookup when nothing else matched.
  if (results.length === 0) {
    const tokenPool = pruned.length > 0 ? pruned : tokens
    const signal = pickHighSignalToken(tokenPool)
    if (signal && signal.length >= 3) {
      const r3 = await safeCall(
        async () => (await Promise.all(
          frameworks.map(fw => runRead(ctx, 'searchTrigram', [signal, { ...filterOpts, framework: fw }])),
        )).flat(),
        { default: [], log: 'warn-once', label: 'search.relax.trigramToken' },
      )
      const before = results.length
      addResults(r3, 'relaxed-token')
      if (results.length > before) relaxationTier = 'trigram'
    }
  }

  return relaxationTier
}

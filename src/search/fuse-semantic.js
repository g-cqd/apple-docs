// fusion-native dispatches to libAppleDocsCore when APPLE_DOCS_NATIVE
// enables the fusion module; ./fusion.js stays the normative JS reference.

import { matchesSearchFilters } from './filters.js'
import { formatResult } from './format.js'
import { hammingSim, hybridFusion, mmrSelect, weightedRRF } from './fusion-native.js'

/**
 * Blend the lexical result order with the semantic candidate order, in place.
 *
 * Score-aware by default (`hybridFusion` adds the normalized
 * semantic-distance magnitude on top of rank fusion); `APPLE_DOCS_FUSION=rrf`
 * reverts to rank-only Weighted RRF. Lexical is weighted higher so exact
 * symbol matches at lexical rank 0 stay ahead of semantic-only hits, and an
 * explicit hoist (below) enforces that invariant *between* exact hits too.
 * Ends with the MMR diversity pass over the head window.
 *
 * @param {any[]} results   lexical results, already rule-reranked (mutated)
 * @param {Array<{ documentId: number, score?: number, vec?: Uint8Array }>} sem
 * @param {{ ctx: any, activeFilters: any, seen: Set<string>, requestedWindow: number,
 *           parseRowPlatforms: (rows: any[]) => void }} io
 */
export function fuseSemanticResults(results, sem, { ctx, activeFilters, seen, requestedWindow, parseRowPlatforms }) {
  // Capture the lexical order + the rule-reranker's calibrated scores BEFORE
  // injecting semantic-only docs, so the lexical fusion signal reflects
  // ranking.js (BASE_SCORES + rules), not the post-injection set.
  const lexicalRanked = results.map((r) => r.path)
  const lexicalScores = new Map(results.map((r) => [r.path, r.score ?? 0]))

  const byId = new Map(ctx.db.getSearchRecordsByIds(sem.map((c) => c.documentId)).map((/** @type {any} */ r) => [r.id, r]))
  const semanticRanked = []
  const semanticScores = new Map()
  const vecByPath = new Map()
  for (const c of sem) {
    const rec = byId.get(c.documentId)
    if (!rec) continue
    parseRowPlatforms([rec])
    if (!matchesSearchFilters(rec, activeFilters)) continue
    semanticRanked.push(rec.path)
    semanticScores.set(rec.path, c.score ?? 0)
    if (c.vec) vecByPath.set(rec.path, c.vec)
    if (!seen.has(rec.path)) {
      seen.add(rec.path)
      results.push(formatResult(rec, 'semantic'))
    }
  }

  const fused =
    (process.env.APPLE_DOCS_FUSION ?? 'hybrid') === 'rrf'
      ? weightedRRF([
          { ranked: lexicalRanked, weight: 1.0 },
          { ranked: semanticRanked, weight: 0.6 },
        ])
      : hybridFusion(
          [
            { ranked: lexicalRanked, weight: 1.0, scores: lexicalScores },
            { ranked: semanticRanked, weight: 0.6, scores: semanticScores },
          ],
          { beta: 0.5 },
        )
  for (const r of results) r.score = fused.get(r.path) ?? 0
  results.sort((a, b) => b.score - a.score)

  // Lexical dominance, enforced: between two exact-title hits the hybrid
  // beta term (up to +0.5·weight) dwarfs their adjacent-rank gap (~1/k²)
  // and can flip them — observed as ToolbarRole's navigationStack
  // outscoring the NavigationStack struct. When the user typed a name
  // verbatim AND only a handful of pages carry that exact title, the
  // rule-reranker's order is authoritative; hoist that block back to the
  // head. With many same-titled pages (e.g. "View") the query is ambiguous
  // and fusion's semantic judgment stays in charge — eval'd: an unbounded
  // hoist costs ndcg@10/mrr on the NL judgment set.
  const exactBlock = results.filter((r) => r.matchQuality === 'exact')
  if (exactBlock.length > 0 && exactBlock.length <= 5) {
    const lexPos = new Map(lexicalRanked.map((p, i) => [p, i]))
    exactBlock.sort((a, b) => (lexPos.get(a.path) ?? Number.POSITIVE_INFINITY) - (lexPos.get(b.path) ?? Number.POSITIVE_INFINITY))
    const rest = results.filter((r) => r.matchQuality !== 'exact')
    results.length = 0
    results.push(...exactBlock, ...rest)
  }

  // MMR diversity over the head window: collapse the near-duplicate "symbol
  // overload" semantic recall tends to surface. Paths without a semantic
  // vector (exact symbol matches) carry redundancy 0 → never demoted, so
  // the rule-rerank winner keeps its slot.
  if (process.env.APPLE_DOCS_MMR !== 'off' && vecByPath.size > 0) {
    const parsed = Number.parseFloat(process.env.APPLE_DOCS_MMR_LAMBDA ?? '0.7')
    const lambda = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.7
    const window = Math.min(results.length, Math.max(requestedWindow, 20))
    const reordered = mmrSelect(results.slice(0, window), (/** @type {any} */ r) => vecByPath.get(r.path) ?? null, hammingSim, { lambda })
    results.splice(0, window, ...reordered)
  }
}

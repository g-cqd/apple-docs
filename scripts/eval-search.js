#!/usr/bin/env bun
/**
 * Read-only search eval harness. Scores ranking quality (recall@10, ndcg@10,
 * mrr) plus the size/latency budget (index_bytes, p50_latency_ms) for several
 * fusion configurations against *our* corpus, so each phase's default flip is
 * gated by numbers rather than generic MTEB scores.
 *
 *   bun run eval:search                 # auto-resolve corpus, print table
 *   bun run eval:search -- --db <path>  # score a specific snapshot DB
 *   bun run eval:search -- --k 10 --anchors 150
 *
 * Corpus resolution: `--db <path>` → `$APPLE_DOCS_HOME/apple-docs.db` if it
 * exists → an in-memory DB seeded from test/golden/seed.js (so it runs offline
 * in CI with no snapshot). Never writes to the DB.
 *
 * Judgments come from two cheap sources:
 *   (a) auto-anchored exact-title queries (corpus-derived, large) — guards that
 *       exact matches are never regressed by fusion/MMR;
 *   (b) the hand-curated NL/synonym set in test/golden/eval-judgments.json —
 *       paraphrases whose relevant paths must surface.
 * Judgments whose relevant paths are absent from the live corpus are skipped.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../src/storage/database.js'
import { search } from '../src/commands/search.js'
import { seedDatabase } from '../test/golden/seed.js'
import { recallAtK, ndcgAtK, mrr, mean } from '../src/search/eval-metrics.js'
import { _resetEmbedder } from '../src/search/embedder.js'
import { _resetVectorCache } from '../src/search/semantic.js'

const SILENT = { debug() {}, info() {}, warn() {}, error() {} }

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++ }
    else out[key] = true
  }
  return out
}

function resolveDb(args) {
  if (typeof args.db === 'string') {
    if (!existsSync(args.db)) { console.error(`eval:search: --db ${args.db} not found`); process.exit(2) }
    return { db: new DocsDatabase(args.db), source: args.db, seeded: false }
  }
  const home = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
  const real = join(home, 'apple-docs.db')
  if (existsSync(real)) return { db: new DocsDatabase(real), source: real, seeded: false }
  const db = new DocsDatabase(':memory:')
  seedDatabase(db)
  return { db, source: 'test/golden/seed.js (in-memory)', seeded: true }
}

/** Every doc path in the corpus — judgments are filtered to these. */
function corpusPaths(db) {
  return new Set(db.db.query('SELECT key FROM documents').all().map(r => r.key))
}

/** Auto-anchored exact-title judgments, evenly sampled across the corpus. */
function anchorJudgments(db, count) {
  const rows = db.db.query("SELECT key, title FROM documents WHERE title IS NOT NULL AND length(title) >= 3 ORDER BY id").all()
  if (rows.length === 0) return []
  const step = Math.max(1, Math.floor(rows.length / count))
  const out = []
  for (let i = 0; i < rows.length && out.length < count; i += step) {
    out.push({ query: rows[i].title, relevant: [rows[i].key], kind: 'anchor' })
  }
  return out
}

function curatedJudgments() {
  const path = join(import.meta.dir, '..', 'test', 'golden', 'eval-judgments.json')
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return (parsed.judgments ?? []).map(j => ({ ...j, kind: 'curated' }))
}

/** Embedding-payload bytes shipped in the DB — the size budget signal. */
function indexBytes(db) {
  let bytes = 0
  const sum = (sql) => { try { return db.db.query(sql).get().b ?? 0 } catch { return 0 } }
  bytes += sum('SELECT SUM(LENGTH(vec)) AS b FROM document_vectors')
  bytes += sum('SELECT SUM(LENGTH(vec_bin) + COALESCE(LENGTH(vec_i8),0) + COALESCE(LENGTH(text),0)) AS b FROM document_chunks')
  return bytes
}

const CONFIGS = [
  { name: 'lexical-only', env: { APPLE_DOCS_SEMANTIC: 'off' } },
  { name: 'baseline-rrf', env: { APPLE_DOCS_FUSION: 'rrf', APPLE_DOCS_MMR: 'off' } },
  { name: 'hybrid', env: { APPLE_DOCS_FUSION: 'hybrid', APPLE_DOCS_MMR: 'off' } },
  { name: 'hybrid+mmr', env: { APPLE_DOCS_FUSION: 'hybrid', APPLE_DOCS_MMR: 'on' } },
]

function applyEnv(env) {
  const prev = {}
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

async function scoreConfig(config, ctx, judgments, k) {
  const restore = applyEnv(config.env)
  _resetEmbedder()
  _resetVectorCache()
  const perKind = { all: [], curated: [], anchor: [] }
  const latencies = []
  try {
    for (const j of judgments) {
      const t0 = performance.now()
      const res = await search({ query: j.query, limit: Math.max(k, 20), noDeep: false, fuzzy: true }, ctx)
      latencies.push(performance.now() - t0)
      const paths = res.results.map(r => r.path)
      const scored = {
        recall: recallAtK(paths, j.relevant, k),
        ndcg: ndcgAtK(paths, j.relevant, k),
        mrr: mrr(paths, j.relevant),
      }
      perKind.all.push(scored)
      perKind[j.kind]?.push(scored)
    }
  } finally {
    restore()
    _resetEmbedder()
    _resetVectorCache()
  }
  latencies.sort((a, b) => a - b)
  const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0
  const agg = (rows) =>
    rows.length
      ? { n: rows.length, recall: mean(rows.map(r => r.recall)), ndcg: mean(rows.map(r => r.ndcg)), mrr: mean(rows.map(r => r.mrr)) }
      : { n: 0, recall: 0, ndcg: 0, mrr: 0 }
  const all = agg(perKind.all)
  return {
    name: config.name,
    recall: all.recall,
    ndcg: all.ndcg,
    mrr: all.mrr,
    p50,
    curated: agg(perKind.curated),
    anchor: agg(perKind.anchor),
  }
}

function printTable(rows, k, idxBytes) {
  const cols = [
    ['config', 14],
    [`recall@${k}`, 11],
    [`ndcg@${k}`, 10],
    ['mrr', 8],
    ['index_bytes', 13],
    ['p50_ms', 8],
  ]
  const header = cols.map(([h, w]) => h.padEnd(w)).join(' ')
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const r of rows) {
    const line = [
      r.name.padEnd(cols[0][1]),
      r.recall.toFixed(4).padEnd(cols[1][1]),
      r.ndcg.toFixed(4).padEnd(cols[2][1]),
      r.mrr.toFixed(4).padEnd(cols[3][1]),
      String(idxBytes).padEnd(cols[4][1]),
      r.p50.toFixed(2).padEnd(cols[5][1]),
    ].join(' ')
    console.log(line)
  }
}

async function main() {
  const args = parseArgs(process.argv)
  const k = Number.parseInt(args.k, 10) || 10
  const anchorCount = Number.parseInt(args.anchors, 10) || 150
  const { db, source, seeded } = resolveDb(args)
  const dataDir = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
  const ctx = { db, dataDir, logger: SILENT }

  try {
    const paths = corpusPaths(db)
    const all = [...anchorJudgments(db, anchorCount), ...curatedJudgments()]
    // Keep only judgments with at least one relevant path present in the corpus.
    const judgments = all
      .map(j => ({ ...j, relevant: j.relevant.filter(p => paths.has(p)) }))
      .filter(j => j.relevant.length > 0)

    const vectorCount = db.getVectorCount?.() ?? 0
    const chunkCount = db.getChunkCount?.() ?? 0
    const idxBytes = indexBytes(db)

    // --json: machine-readable result on stdout, info lines on stderr —
    // the embed-model bake-off harness consumes this.
    const emit = args.json ? console.error : console.log
    emit(`corpus:     ${source}`)
    emit(`documents:  ${paths.size}`)
    emit(`vectors:    ${vectorCount}  chunks: ${chunkCount}  (semantic ${vectorCount > 0 || chunkCount > 0 ? 'active' : 'dormant'})`)
    emit(`judgments:  ${judgments.length} resolvable (${all.length - judgments.length} skipped — relevant paths absent)`)
    if (seeded) emit('note:       seeded corpus has no embedding model — configs differ only when a real snapshot ships vectors.')
    emit('')

    const rows = []
    for (const config of CONFIGS) rows.push(await scoreConfig(config, ctx, judgments, k))
    if (args.json) {
      let embedMeta = {}
      try {
        embedMeta = {
          embedModel: db.getSnapshotMeta('embed_model') ?? null,
          embedDims: db.getSnapshotMeta('embed_dims') ?? null,
        }
      } catch { /* meta table absent on seeded DBs */ }
      console.log(JSON.stringify({
        source, documents: paths.size, vectors: vectorCount, chunks: chunkCount,
        indexBytes: idxBytes, k, judgments: judgments.length, ...embedMeta, rows,
      }))
    } else {
      printTable(rows, k, idxBytes)
    }
  } finally {
    db.close()
  }
}

await main()

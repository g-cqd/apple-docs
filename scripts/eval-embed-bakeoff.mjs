#!/usr/bin/env bun
/**
 * Embedding-model bake-off (RFC 0002 D-0002-5): scores candidate default
 * models on OUR retrieval eval, on the SAME pruned subset corpus, with
 * index-build cost and query latency measured per model.
 *
 *   bun scripts/eval-embed-bakeoff.mjs                       # both models
 *   bun scripts/eval-embed-bakeoff.mjs --models potion-retrieval-32M
 *   bun scripts/eval-embed-bakeoff.mjs --fresh               # rebuild scratch copy
 *   bun scripts/eval-embed-bakeoff.mjs --abort-after-min 90  # cap an index leg
 *   bun scripts/eval-embed-bakeoff.mjs --query-bench <model> # internal child mode
 *
 * Heavy phases run in CHILD processes (the embedder caches per process, and
 * `/usr/bin/time -l` gives wall-clock + peak RSS for free). The scratch home
 * is a pruned COPY of the live corpus — the live DB is never touched.
 *
 * Trap guard: a mis-set APPLE_DOCS_EMBED_MODEL makes query embedding silently
 * width-mismatch and the eval degrade to lexical-only (semantic.js). Every
 * leg asserts snapshot_meta.embed_model matches AND hybrid metrics actually
 * differ from the lexical-only control before results are recorded.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const ROOT = new URL('..', import.meta.url).pathname
const DEFAULT_MODELS = ['potion-retrieval-32M', 'embeddinggemma-300m']
const SCOPE_FRAMEWORKS = ['swiftui', 'foundation', 'uikit', 'combine', 'swift']

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

const args = parseArgs(process.argv)
const scratch = args.scratch ?? join(homedir(), '.cache', 'apple-docs-embed-bakeoff')
const liveHome = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const modelsDir = process.env.APPLE_DOCS_MODELS_DIR ?? join(liveHome, 'resources', 'models')

function log(msg) {
  console.error(`[bakeoff] ${msg}`)
}

function childEnv(model) {
  return {
    ...process.env,
    APPLE_DOCS_HOME: scratch,
    APPLE_DOCS_MODELS_DIR: modelsDir,
    APPLE_DOCS_EMBED_MODEL: model,
    APPLE_DOCS_ALLOW_REMOTE_MODELS: '1',
    APPLE_DOCS_LOG_LEVEL: 'info',
  }
}

function scratchDbPath() {
  return join(scratch, 'apple-docs.db')
}

function roQuery(sql) {
  const db = new Database(scratchDbPath(), { readonly: true })
  try {
    return db.query(sql).get()
  } finally {
    db.close()
  }
}

async function run(cmd, { env, label, timeoutMs } = {}) {
  log(`$ ${cmd.join(' ')}`)
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    env: env ?? process.env,
    stdout: 'inherit',
    stderr: 'inherit',
    ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGKILL' } : {}),
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${label ?? cmd[0]} exited ${code}`)
}

async function prepareScratch() {
  const marker = join(scratch, '.prepared')
  if (existsSync(marker) && !args.fresh) {
    const docs = roQuery('SELECT COUNT(*) AS c FROM documents').c
    log(`reusing scratch corpus at ${scratch} (${docs} docs) — pass --fresh to rebuild`)
    return
  }
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  const src = join(liveHome, 'apple-docs.db')
  if (!existsSync(src)) throw new Error(`no live corpus at ${src}`)
  log(`copying live DB (sqlite3 .backup) → ${scratchDbPath()}`)
  await run(['sqlite3', src, `.backup '${scratchDbPath()}'`], { label: 'sqlite3 backup' })
  writeFileSync(
    join(scratch, 'scope.json'),
    `${JSON.stringify({ version: 1, appleDoccFrameworks: SCOPE_FRAMEWORKS, keepFonts: false, keepSymbols: false }, null, 2)}\n`,
  )
  log(`pruning to scope (${SCOPE_FRAMEWORKS.join(', ')} + all non-docc sources)…`)
  await run(['bun', 'cli.js', 'prune', '--home', scratch], { label: 'prune' })
  const docs = roQuery('SELECT COUNT(*) AS c FROM documents').c
  log(`scratch corpus ready: ${docs} docs`)
  writeFileSync(marker, `${new Date().toISOString()}\n`)
}

function startEtaWatcher(expectedTotal) {
  const samples = []
  const timer = setInterval(() => {
    try {
      const chunks = roQuery('SELECT COUNT(*) AS c FROM document_chunks').c
      samples.push({ t: Date.now(), chunks })
      if (samples.length >= 2) {
        const first = samples[0]
        const last = samples.at(-1)
        const rate = ((last.chunks - first.chunks) / (last.t - first.t)) * 1000
        if (rate > 0) {
          const etaMin = (expectedTotal - last.chunks) / rate / 60
          log(`index progress: ${last.chunks} chunks · ${rate.toFixed(1)} chunks/s · ~${etaMin.toFixed(0)} min remaining (of ~${expectedTotal})`)
        }
      }
    } catch {
      /* DB busy mid-transaction — skip the tick */
    }
  }, 60_000)
  return () => clearInterval(timer)
}

async function indexLeg(model) {
  const docs = roQuery('SELECT COUNT(*) AS c FROM documents').c
  const expectedChunks = Math.round(docs * 2.44)
  log(`=== ${model}: index ${docs} docs (~${expectedChunks} chunks expected) ===`)
  const stopEta = startEtaWatcher(expectedChunks)
  const t0 = Date.now()
  const proc = Bun.spawn(['/usr/bin/time', '-l', 'bun', 'cli.js', 'index', 'embeddings', '--full', '--home', scratch], {
    cwd: ROOT,
    env: childEnv(model),
    stdout: 'inherit',
    stderr: 'pipe',
    ...(args['abort-after-min'] ? { timeout: Number(args['abort-after-min']) * 60_000, killSignal: 'SIGKILL' } : {}),
  })
  const stderrText = await new Response(proc.stderr).text()
  const code = await proc.exited
  stopEta()
  process.stderr.write(stderrText.split('\n').filter(l => !l.trim().startsWith('0 ')).join('\n'))
  if (code !== 0) throw new Error(`index leg for ${model} exited ${code} (aborted?)`)
  const wallS = (Date.now() - t0) / 1000
  const rssMatch = stderrText.match(/(\d+)\s+maximum resident set size/)
  const peakRssMb = rssMatch ? Number(rssMatch[1]) / 1024 / 1024 : null

  const meta = roQuery("SELECT value FROM snapshot_meta WHERE key = 'embed_model'")?.value
  if (meta !== model) throw new Error(`trap guard: snapshot_meta.embed_model='${meta}' but leg ran '${model}'`)
  const dims = roQuery("SELECT value FROM snapshot_meta WHERE key = 'embed_dims'")?.value
  const chunks = roQuery('SELECT COUNT(*) AS c FROM document_chunks').c
  const idxBytes = roQuery('SELECT SUM(LENGTH(vec_bin) + COALESCE(LENGTH(vec_i8),0) + COALESCE(LENGTH(text),0)) AS b FROM document_chunks').b
  return { wallS, chunksPerS: chunks / wallS, peakRssMb, dims: Number(dims), chunks, idxBytes }
}

async function evalLeg(model) {
  log(`=== ${model}: eval (lexical control + hybrid+mmr) ===`)
  const proc = Bun.spawn(['bun', 'scripts/eval-search.js', '--json', '--anchors', String(args.anchors ?? 150)], {
    cwd: ROOT,
    env: childEnv(model),
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`eval leg for ${model} exited ${code}`)
  const parsed = JSON.parse(out.trim().split('\n').at(-1))
  if (parsed.embedModel !== model) {
    throw new Error(`trap guard: eval ran against embed_model='${parsed.embedModel}', expected '${model}'`)
  }
  const lexical = parsed.rows.find(r => r.name === 'lexical-only')
  const hybrid = parsed.rows.find(r => r.name === 'hybrid+mmr')
  if (!lexical || !hybrid) throw new Error('eval output missing configs')
  const identical =
    Math.abs(hybrid.ndcg - lexical.ndcg) < 1e-9 &&
    Math.abs(hybrid.recall - lexical.recall) < 1e-9 &&
    Math.abs(hybrid.mrr - lexical.mrr) < 1e-9
  if (identical) {
    throw new Error('trap guard: hybrid metrics identical to lexical-only — the semantic tier silently did not run')
  }
  return parsed
}

async function queryBenchChild(model) {
  // Child mode: loads the embedder once, embeds each curated query 3×.
  const { getEmbedder } = await import('../src/search/embedder.js')
  const judgments = JSON.parse(readFileSync(join(ROOT, 'test', 'golden', 'eval-judgments.json'), 'utf8')).judgments
  const queries = judgments.map(j => j.query)
  const t0 = performance.now()
  const embedder = await getEmbedder({ logger: { debug() {}, info() {}, warn() {}, error() {} } })
  const loadMs = performance.now() - t0
  await embedder.embed('warmup')
  const times = []
  for (let round = 0; round < 3; round++) {
    for (const q of queries) {
      const t = performance.now()
      await embedder.embed(q)
      times.push(performance.now() - t)
    }
  }
  times.sort((a, b) => a - b)
  console.log(JSON.stringify({
    model,
    loadMs,
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.floor(times.length * 0.95)],
    n: times.length,
  }))
}

async function queryBenchLeg(model) {
  log(`=== ${model}: query micro-bench ===`)
  const proc = Bun.spawn(['bun', 'scripts/eval-embed-bakeoff.mjs', '--query-bench', model], {
    cwd: ROOT,
    env: childEnv(model),
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error(`query bench for ${model} failed`)
  return JSON.parse(out.trim().split('\n').at(-1))
}

function modelArtifacts(model) {
  // Registry hfIds: keep in sync with src/search/embedder.js REGISTRY.
  const hfId = model === 'potion-retrieval-32M' ? 'minishlab/potion-retrieval-32M' : `onnx-community/${model}-ONNX`
  const dir = join(modelsDir, hfId)
  let bytes = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else bytes += statSync(p).size
    }
  }
  try {
    walk(dir)
  } catch {
    /* not yet downloaded — the index leg fetches it */
  }
  return { hfId, sizeMb: bytes / 1e6 }
}

function fmtRow(r) {
  return `| ${r.model} | ${r.dims} | ${r.artifactMb.toFixed(0)} MB | ${(r.index.wallS / 60).toFixed(1)} min | ${r.index.chunksPerS.toFixed(1)} | ${r.index.peakRssMb?.toFixed(0) ?? '?'} MB | ${r.query.p50.toFixed(1)} / ${r.query.p95.toFixed(1)} ms | ${r.hybrid.recall.toFixed(4)} | ${r.hybrid.ndcg.toFixed(4)} | ${r.hybrid.mrr.toFixed(4)} | ${r.hybrid.curated.ndcg.toFixed(4)} / ${r.hybrid.anchor.ndcg.toFixed(4)} | ${(r.index.idxBytes / 1e6).toFixed(0)} MB |`
}

async function main() {
  if (args['query-bench']) return queryBenchChild(args['query-bench'])
  const models = (args.models ? String(args.models).split(',') : DEFAULT_MODELS).map(m => m.trim())
  await prepareScratch()
  const results = []
  let lexicalControl = null
  for (const model of models) {
    const index = await indexLeg(model)
    const evalOut = await evalLeg(model)
    const query = await queryBenchLeg(model)
    const hybrid = evalOut.rows.find(r => r.name === 'hybrid+mmr')
    lexicalControl ??= evalOut.rows.find(r => r.name === 'lexical-only')
    results.push({ model, dims: index.dims, artifactMb: modelArtifacts(model).sizeMb, index, query, hybrid, evalOut })
  }

  console.log('\n## Bake-off results (subset corpus, hybrid+mmr)\n')
  console.log(`subset: ${results[0]?.evalOut.documents} docs · ${results[0]?.index.chunks} chunks · judgments ${results[0]?.evalOut.judgments}`)
  if (lexicalControl) {
    console.log(`lexical-only control: recall ${lexicalControl.recall.toFixed(4)} · ndcg ${lexicalControl.ndcg.toFixed(4)} · mrr ${lexicalControl.mrr.toFixed(4)}\n`)
  }
  console.log('| model | dims | artifact | index wall | chunks/s | peak RSS | query p50/p95 | recall@10 | ndcg@10 | mrr | ndcg curated/anchor | index bytes |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) console.log(fmtRow(r))

  const outPath = join(scratch, `results-${Date.now()}.json`)
  writeFileSync(outPath, JSON.stringify({ when: new Date().toISOString(), models, results }, null, 2))
  log(`raw results → ${outPath}`)
}

await main()

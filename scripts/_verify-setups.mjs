#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Throwaway end-to-end verification harness (not shipped; underscore-prefixed).
 *
 * For each install "setup", it crawls a FRESH corpus into an isolated
 * APPLE_DOCS_HOME, applies the setup's storage shape, builds the semantic
 * index, exercises every user-facing feature through the real `cli.js`, then
 * tears the home down to reclaim disk before the next setup. A pass/fail matrix
 * is written to <out>/verify-report.{json,md} and streamed to <out>/verify.log.
 *
 *   bun scripts/_verify-setups.mjs --mode smoke --scope swift-evolution
 *   bun scripts/_verify-setups.mjs --mode full  --setups raw-only,balanced,prebuilt,compact,snapshot
 *
 * --mode smoke  : scoped single-adapter crawl (minutes) — validates the harness.
 * --mode full   : real `sync --full` per setup (hours each) — the real matrix.
 */

import { existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const ROOT = join(import.meta.dir, '..')
const CLI = join(ROOT, 'cli.js')

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++ }
    else out[key] = true
  }
  return out
}

const args = parseArgs(process.argv)
const MODE = args.mode === 'full' ? 'full' : 'smoke'
const SCOPE = typeof args.scope === 'string' ? args.scope : 'swift-evolution'
const SETUPS = (typeof args.setups === 'string' ? args.setups.split(',') : ['raw-only', 'balanced', 'prebuilt', 'compact', 'snapshot'])
  .map(s => s.trim()).filter(Boolean)
// Base lives under $HOME so the snapshot-install path guard (archive must be
// under $HOME or cwd) is satisfied. tmpdir() is on the same volume anyway.
const BASE = args.base ? String(args.base) : mkdtempSync(join(homedir(), '.apple-docs-verify-'))
const OUT = args.out ? String(args.out) : join(BASE, 'report')
const MIN_FREE_GB = Number(args['min-free-gb'] ?? 20)
// Shared model dir so the model2vec model downloads once and is reused offline.
const MODELS_DIR = join(BASE, 'models')

mkdirSync(OUT, { recursive: true })
mkdirSync(MODELS_DIR, { recursive: true })
const LOG = join(OUT, 'verify.log')

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  appendFileSync(LOG, line + '\n')
}

function freeGB(path) {
  // `df -k -P <path>` → portable; 4th column = available 1K-blocks.
  const r = Bun.spawnSync(['df', '-k', '-P', path])
  const lines = new TextDecoder().decode(r.stdout).trim().split('\n')
  const cols = lines[lines.length - 1].split(/\s+/)
  return Math.round(Number(cols[3]) / 1024 / 1024)
}

/** Run cli.js with a given home; returns { code, stdout, stderr, json }. */
async function cli(homeDir, cmdArgs, { extraEnv = {}, timeoutMs = 0 } = {}) {
  const env = {
    ...process.env,
    APPLE_DOCS_HOME: homeDir,
    APPLE_DOCS_MODELS_DIR: MODELS_DIR,
    ...extraEnv,
  }
  const proc = Bun.spawn(['bun', CLI, ...cmdArgs], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' })
  let timer
  if (timeoutMs > 0) timer = setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
  const code = await proc.exited
  if (timer) clearTimeout(timer)
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  let json
  try { json = JSON.parse(stdout) } catch {}
  return { code, stdout, stderr, json }
}

/** Scoped single-adapter crawl (smoke). Runs sync() in-process. */
async function scopedCrawl(homeDir, adapterType) {
  const { DocsDatabase } = await import(join(ROOT, 'src/storage/database.js'))
  const { sync } = await import(join(ROOT, 'src/commands/sync.js'))
  const { getAdapter } = await import(join(ROOT, 'src/sources/registry.js'))
  const { createLogger } = await import(join(ROOT, 'src/lib/logger.js'))
  const { createHostBucketedLimiter } = await import(join(ROOT, 'src/lib/per-host-rate-limiter.js'))
  const adapter = getAdapter(adapterType) // returns an instance, not the class
  const db = new DocsDatabase(join(homeDir, 'apple-docs.db'))
  const rateLimiter = createHostBucketedLimiter({ defaults: { rate: 5, burst: 5 }, primary: { rate: 5, burst: 5 } })
  const ctx = { db, dataDir: homeDir, rateLimiter, logger: createLogger('error'), adapters: [adapter] }
  try {
    const r = await sync({ full: true }, ctx)
    return r
  } finally {
    db.close()
  }
}

/** Full corpus crawl (the real path the user runs). */
async function fullCrawl(homeDir) {
  log(`  sync --full (this is the multi-hour step)…`)
  const r = await cli(homeDir, ['sync', '--full'], { timeoutMs: 4 * 60 * 60 * 1000 })
  if (r.code !== 0) throw new Error(`sync --full failed (exit ${r.code}): ${r.stderr.slice(-500)}`)
  return r
}

/** A single yes/no probe. */
async function probe(checks, name, fn) {
  try {
    const detail = await fn()
    checks.push({ name, ok: true, detail: detail ?? '' })
    log(`    ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (err) {
    checks.push({ name, ok: false, detail: err.message })
    log(`    ✗ ${name} — ${err.message}`)
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }

/** Exercise every user-facing feature against a populated home. */
async function runFeatureChecks(homeDir, setup) {
  const checks = []

  await probe(checks, 'status reports a non-empty corpus', async () => {
    const r = await cli(homeDir, ['status', '--json'])
    assert(r.code === 0 && r.json, `status exit ${r.code}`)
    const docs = r.json.pages?.active ?? 0
    assert(Number(docs) > 0, `no active pages (${JSON.stringify(r.json).slice(0, 120)})`)
    return `${docs} active pages, ${r.json.roots?.total ?? 0} roots`
  })

  await probe(checks, 'frameworks lists roots', async () => {
    const r = await cli(homeDir, ['frameworks', '--json'])
    assert(r.code === 0 && r.json, `frameworks exit ${r.code}`)
    const arr = Array.isArray(r.json) ? r.json : (r.json.frameworks ?? r.json.roots ?? [])
    assert(arr.length > 0, 'no frameworks')
    return `${arr.length} roots`
  })

  await probe(checks, 'kinds lists taxonomy', async () => {
    const r = await cli(homeDir, ['kinds', '--json'])
    assert(r.code === 0, `kinds exit ${r.code}`)
    return 'ok'
  })

  // Derive a real query + path from the corpus so checks are corpus-agnostic.
  let sampleQuery = MODE === 'smoke' ? 'concurrency' : 'view'
  let samplePath = null
  let sampleFramework = null
  await probe(checks, `search returns hits for "${sampleQuery}"`, async () => {
    const r = await cli(homeDir, ['search', sampleQuery, '--json'])
    assert(r.code === 0 && r.json, `search exit ${r.code}`)
    const hits = Array.isArray(r.json) ? r.json : (r.json.results ?? r.json.hits ?? [])
    assert(hits.length > 0, 'zero results')
    const top = hits[0]
    samplePath = top.path ?? top.key ?? top.url ?? null
    sampleFramework = top.framework ?? top.root_slug ?? top.rootSlug ?? null
    return `${hits.length} hits, top=${samplePath ?? '?'}`
  })

  await probe(checks, 'search exact title resolves (tier-0)', async () => {
    const r = await cli(homeDir, ['search', MODE === 'smoke' ? 'Async/Await' : 'View', '--json'])
    assert(r.code === 0 && r.json, `search exit ${r.code}`)
    const hits = Array.isArray(r.json) ? r.json : (r.json.results ?? [])
    assert(hits.length > 0, 'zero results for exact title')
    return `${hits.length} hits`
  })

  await probe(checks, 'read returns content for a real path', async () => {
    assert(samplePath, 'no sample path from search')
    const r = await cli(homeDir, ['read', samplePath, '--json'])
    assert(r.code === 0 && r.json, `read exit ${r.code} (${r.stderr.slice(-200)})`)
    return `read ${samplePath}`
  })

  await probe(checks, 'browse returns a topic tree', async () => {
    assert(sampleFramework, 'no sample framework from search')
    const r = await cli(homeDir, ['browse', sampleFramework, '--json'])
    assert(r.code === 0, `browse exit ${r.code}`)
    return `browse ${sampleFramework}`
  })

  await probe(checks, 'storage stats reports a breakdown', async () => {
    const r = await cli(homeDir, ['storage', 'stats', '--json'])
    assert(r.code === 0 && r.json, `storage stats exit ${r.code}`)
    return `total=${r.json.total ?? '?'}`
  })

  // Semantic tier: vectors present → an NL query should resolve. Only assert
  // when the index was built (it is, below, before feature checks).
  await probe(checks, 'semantic NL query resolves (fusion)', async () => {
    const q = MODE === 'smoke' ? 'how does Swift handle asynchronous code' : 'how do I record audio in the background'
    const r = await cli(homeDir, ['search', q, '--json'])
    assert(r.code === 0 && r.json, `search exit ${r.code}`)
    const hits = Array.isArray(r.json) ? r.json : (r.json.results ?? [])
    assert(hits.length > 0, 'zero results for NL query')
    return `${hits.length} hits`
  })

  // Profile-specific on-disk expectations.
  if (setup === 'prebuilt') {
    await probe(checks, 'prebuilt materialized markdown on disk', async () => {
      const md = join(homeDir, 'markdown')
      assert(existsSync(md), 'no markdown/ dir')
      return 'markdown/ present'
    })
  }

  return checks
}

/** Build a snapshot, verify determinism, install it fresh, and search offline. */
async function snapshotRoundTrip(homeDir, setup) {
  const checks = []
  const distA = join(homeDir, 'distA')
  const distB = join(homeDir, 'distB')

  await probe(checks, 'snapshot build produces an archive', async () => {
    const r = await cli(homeDir, ['snapshot', 'build', '--out', distA, '--tag', 'verify-snap', '--allow-incomplete-symbols'], { timeoutMs: 60 * 60 * 1000 })
    assert(r.code === 0, `snapshot build exit ${r.code}: ${r.stderr.slice(-300)}`)
    return 'built'
  })

  await probe(checks, 'two builds are bit-identical (determinism gate)', async () => {
    const r = await cli(homeDir, ['snapshot', 'build', '--out', distB, '--tag', 'verify-snap', '--allow-incomplete-symbols'], { timeoutMs: 60 * 60 * 1000 })
    assert(r.code === 0, `2nd build exit ${r.code}`)
    const sh = (d) => {
      const f = Bun.spawnSync(['sh', '-c', `ls ${d}/*.tar.zst`]).stdout
      const path = new TextDecoder().decode(f).trim().split('\n')[0]
      const out = Bun.spawnSync(['shasum', '-a', '256', path]).stdout
      return new TextDecoder().decode(out).trim().split(/\s+/)[0]
    }
    const a = sh(distA), b = sh(distB)
    assert(a && a === b, `sha mismatch: ${a} vs ${b}`)
    return a.slice(0, 12)
  })

  await probe(checks, 'install from snapshot (fresh home)', async () => {
    const archive = new TextDecoder().decode(Bun.spawnSync(['sh', '-c', `ls ${distA}/*.tar.zst`]).stdout).trim().split('\n')[0]
    // Fail honestly rather than letting an empty path fall through to a remote
    // download (which would pass against a *published* snapshot, not our build).
    assert(archive && existsSync(archive), 'no locally-built archive to install (build failed?)')
    const freshHome = join(homeDir, 'installed')
    mkdirSync(freshHome, { recursive: true })
    const r = await cli(freshHome, ['setup', '--archive', archive, '--yes'], { timeoutMs: 60 * 60 * 1000 })
    assert(r.code === 0, `setup --archive exit ${r.code}: ${r.stderr.slice(-300)}`)
    // Offline semantic search on the installed snapshot (no remote model).
    const s = await cli(freshHome, ['search', MODE === 'smoke' ? 'asynchronous code' : 'record audio background', '--json'], { extraEnv: { APPLE_DOCS_ALLOW_REMOTE_MODELS: '' } })
    assert(s.code === 0 && s.json, `offline search exit ${s.code}`)
    return 'installed + searched offline'
  })

  return checks
}

async function runSetup(setup) {
  const home = join(BASE, setup)
  log(`\n=== SETUP: ${setup} (mode=${MODE}) ===`)
  const free = freeGB(BASE)
  log(`  free disk at ${BASE}: ${free} GB`)
  if (free < MIN_FREE_GB) throw new Error(`insufficient disk: ${free} GB < ${MIN_FREE_GB} GB floor`)

  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })

  // 1. Crawl fresh.
  if (MODE === 'smoke') {
    log(`  scoped crawl: ${SCOPE}`)
    await scopedCrawl(home, SCOPE)
  } else {
    await fullCrawl(home)
  }

  // 2. Apply the storage shape for this setup.
  const profile = setup === 'compact' ? 'balanced' : (setup === 'snapshot' ? 'prebuilt' : setup)
  if (['raw-only', 'balanced', 'prebuilt'].includes(profile)) {
    await cli(home, ['storage', 'profile', profile])
  }
  if (setup === 'prebuilt' || setup === 'snapshot') {
    await cli(home, ['storage', 'materialize', '--format', 'markdown'], { timeoutMs: 60 * 60 * 1000 })
    await cli(home, ['storage', 'materialize', '--format', 'html'], { timeoutMs: 60 * 60 * 1000 })
  }

  // 3. Build the semantic index (downloads the model once into MODELS_DIR).
  log(`  index embeddings…`)
  const emb = await cli(home, ['index', 'embeddings'], { extraEnv: { APPLE_DOCS_ALLOW_REMOTE_MODELS: '1' }, timeoutMs: 60 * 60 * 1000 })
  if (emb.code !== 0) log(`    (embeddings exit ${emb.code}: ${emb.stderr.slice(-200)})`)

  if (setup === 'compact') {
    await cli(home, ['storage', 'compact', '--force'], { timeoutMs: 60 * 60 * 1000 })
  }

  // 4. Feature checks.
  let checks = await runFeatureChecks(home, setup)
  if (setup === 'snapshot') {
    checks = checks.concat(await snapshotRoundTrip(home, setup))
  }

  // 5. Teardown to reclaim disk before the next setup.
  rmSync(home, { recursive: true, force: true })
  log(`  torn down ${home}`)

  return { setup, checks, passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length }
}

const results = []
log(`verify-setups starting: mode=${MODE} setups=[${SETUPS.join(', ')}] base=${BASE}`)
for (const setup of SETUPS) {
  try {
    results.push(await runSetup(setup))
  } catch (err) {
    log(`!! SETUP ${setup} aborted: ${err.message}`)
    results.push({ setup, checks: [], passed: 0, failed: 1, error: err.message })
  }
  writeFileSync(join(OUT, 'verify-report.json'), JSON.stringify({ mode: MODE, base: BASE, results }, null, 2))
}

// Markdown matrix.
let md = `# Setup verification (${MODE})\n\nBase: \`${BASE}\`\n\n`
for (const r of results) {
  md += `## ${r.setup} — ${r.failed === 0 && !r.error ? 'PASS' : 'FAIL'} (${r.passed}✓ / ${r.failed}✗)\n\n`
  if (r.error) md += `> aborted: ${r.error}\n\n`
  for (const c of r.checks) md += `- ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}\n`
  md += '\n'
}
writeFileSync(join(OUT, 'verify-report.md'), md)
log(`\nDONE. Report: ${join(OUT, 'verify-report.md')}`)
console.log('\n' + md)

const anyFail = results.some(r => r.failed > 0 || r.error)
process.exit(anyFail ? 1 : 0)

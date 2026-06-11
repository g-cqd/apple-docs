/**
 * RFC 0002 phase-4 retrieval-equivalence gate: prove that a corpus indexed
 * through the NATIVE embed path is byte-identical to one indexed through
 * the JS/transformers path — byte-identical `vec_bin`/`vec_i8` blobs imply
 * identical retrieval forever, which is strictly stronger than comparing
 * eval metrics (run those too with --eval for a human-readable receipt).
 *
 * Local-only: needs the live corpus DB, the pinned model, and a release
 * dylib (swift build -c release --package-path swift). Both legs pin the
 * SAME models dir; leg B additionally derives/uses the ADMX artifact.
 *
 *   bun scripts/verify-embed-equivalence.mjs [--eval]
 */

import { mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { suffix } from 'bun:ffi'

const ROOT = join(import.meta.dir, '..')
const DEV_LIB = join(ROOT, 'swift', '.build', 'release', `libAppleDocsCore.${suffix}`)
const liveHome = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const liveDb = join(liveHome, 'apple-docs.db')
const modelsDir = process.env.APPLE_DOCS_MODELS_DIR ?? join(liveHome, 'resources', 'models')
const runEval = process.argv.includes('--eval')

const scratchRoot = join(tmpdir(), `embed-equivalence-${Date.now()}`)
const homes = { js: join(scratchRoot, 'js'), native: join(scratchRoot, 'native') }

async function run(cmd, env, label) {
  const started = performance.now()
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const seconds = (performance.now() - started) / 1000
  if (code !== 0) {
    throw new Error(`${label} failed (${code}):\n${err.slice(-2000)}\n${out.slice(-500)}`)
  }
  console.log(`  ${label}: ${seconds.toFixed(1)}s`)
  return { out, err, seconds }
}

console.log('preparing scratch copies…')
// ONE backup, then byte-copies: the live DB moves (server processes write),
// and two sequential backups would seed the legs with different corpora.
mkdirSync(homes.js, { recursive: true })
mkdirSync(homes.native, { recursive: true })
await run(['sqlite3', liveDb, `.backup '${join(homes.js, 'apple-docs.db')}'`], {}, 'backup')
await run(['cp', join(homes.js, 'apple-docs.db'), join(homes.native, 'apple-docs.db')], {}, 'copy')

const baseEnv = {
  APPLE_DOCS_MODELS_DIR: modelsDir,
  APPLE_DOCS_LOG_LEVEL: 'warn',
}

console.log('indexing leg A (JS / transformers)…')
const legA = await run(
  ['bun', 'cli.js', 'index', 'embeddings', '--full', '--home', homes.js],
  { ...baseEnv, APPLE_DOCS_NATIVE: 'off' }, // explicit: '' means native-on since the default flip
  'leg A',
)

console.log('indexing leg B (native)…')
const legB = await run(
  ['bun', 'cli.js', 'index', 'embeddings', '--full', '--home', homes.native],
  { ...baseEnv, APPLE_DOCS_NATIVE: 'embed', APPLE_DOCS_NATIVE_LIB: DEV_LIB },
  'leg B',
)

console.log('comparing indexes…')
const db = new Database(join(homes.js, 'apple-docs.db'), { readonly: true })
db.run(`ATTACH DATABASE '${join(homes.native, 'apple-docs.db')}' AS native`)

const counts = db
  .query(
    `SELECT (SELECT COUNT(*) FROM main.document_chunks) AS a,
            (SELECT COUNT(*) FROM native.document_chunks) AS b`,
  )
  .get()
const blobMismatches = db
  .query(
    `SELECT COUNT(*) AS n FROM main.document_chunks a
     JOIN native.document_chunks b USING (document_id, ord)
     WHERE a.vec_bin != b.vec_bin OR a.vec_i8 != b.vec_i8`,
  )
  .get().n
const unmatched = db
  .query(
    `SELECT (SELECT COUNT(*) FROM main.document_chunks a
             LEFT JOIN native.document_chunks b USING (document_id, ord)
             WHERE b.document_id IS NULL) +
            (SELECT COUNT(*) FROM native.document_chunks b
             LEFT JOIN main.document_chunks a USING (document_id, ord)
             WHERE a.document_id IS NULL) AS n`,
  )
  .get().n
const anchorMismatches = db
  .query(
    `SELECT COUNT(*) AS n FROM main.document_vectors a
     JOIN native.document_vectors b USING (document_id)
     WHERE a.vec != b.vec`,
  )
  .get().n
const meta = db
  .query(
    `SELECT (SELECT value FROM main.snapshot_meta WHERE key = 'embed_dims') AS adims,
            (SELECT value FROM native.snapshot_meta WHERE key = 'embed_dims') AS bdims`,
  )
  .get()
db.close()

console.log(`  chunks: ${counts.a} (js) vs ${counts.b} (native)`)
console.log(`  blob mismatches: ${blobMismatches}; unmatched rows: ${unmatched}; anchor mismatches: ${anchorMismatches}`)
console.log(`  embed_dims: ${meta.adims} vs ${meta.bdims}`)
console.log(`  speedup: ${(legA.seconds / legB.seconds).toFixed(2)}x end-to-end`)

let evalIdentical = null
if (runEval) {
  console.log('running golden eval on both legs…')
  const evalRows = {}
  for (const [name, home] of Object.entries(homes)) {
    const { out } = await run(
      ['bun', 'scripts/eval-search.js', '--json', '--db', join(home, 'apple-docs.db')],
      baseEnv,
      `eval ${name}`,
    )
    // Quality metrics only — the wall-clock field (p50) differs run to run.
    const parsed = JSON.parse(out)
    evalRows[name] = parsed.rows.map(({ p50, ...metrics }) => metrics)
  }
  evalIdentical = JSON.stringify(evalRows.js) === JSON.stringify(evalRows.native)
  console.log(`  eval rows identical (quality metrics): ${evalIdentical}`)
  if (!evalIdentical) {
    for (let i = 0; i < evalRows.js.length; i++) {
      const a = JSON.stringify(evalRows.js[i])
      const b = JSON.stringify(evalRows.native[i])
      if (a !== b) console.log(`  row ${i} differs:\n    js:     ${a}\n    native: ${b}`)
    }
  }
}

rmSync(scratchRoot, { recursive: true, force: true })

const pass =
  counts.a === counts.b &&
  counts.a > 0 &&
  blobMismatches === 0 &&
  unmatched === 0 &&
  anchorMismatches === 0 &&
  meta.adims === meta.bdims &&
  evalIdentical !== false
console.log(pass ? 'EQUIVALENT — native index is byte-identical to the JS index' : 'MISMATCH — do not flip the default')
process.exit(pass ? 0 : 1)

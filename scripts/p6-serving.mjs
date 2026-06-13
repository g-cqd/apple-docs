// RFC 0001 P6 — classic-vs-async serving-model head-to-head. Both ad-server
// modes run the IDENTICAL one-offload sequential cascade (Cascade.search); the
// ONLY difference is the serving model: --serving classic (EL-confined
// ChannelInboundHandler, @unchecked) vs --serving async (NIOAsyncChannel +
// per-request Task, no @unchecked). Settles "keep the @unchecked classic
// handler ONLY if it is measurably better." ab -k at c=1/4/8/16.
//
//   bun scripts/p6-serving.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AD_SERVER = new URL('../swift/.build/release/ad-server', import.meta.url).pathname
const FRAMEWORKS = ['swiftui', 'uikit', 'foundation', 'combine', 'coredata', 'mapkit', 'avfoundation', 'metal']
const TERMS = ['view', 'data', 'model', 'render', 'layer', 'object', 'value', 'controller']
const THREADS = 8
const PORT = 3037
const N = 6000
const CS = [1, 4, 8, 16]
const QUERY = 'q=view&limit=100'

const dir = mkdtempSync(join(tmpdir(), 'p6-serving-'))
const dbPath = join(dir, 'corpus.db')
{
  const { DocsDatabase } = await import('../src/storage/database.js')
  const db = new DocsDatabase(dbPath)
  for (const fw of FRAMEWORKS) db.upsertRoot(fw, fw.toUpperCase(), 'framework', 'bench')
  for (const fw of FRAMEWORKS)
    for (let i = 0; i < 60; i++) {
      const t = TERMS[i % TERMS.length]
      db.upsertDocument({ key: `${fw}/sym${i}`, title: `${t[0].toUpperCase()}${t.slice(1)}${i}`, framework: fw, sourceType: 'apple-docc', role: 'symbol', kind: 'struct', language: 'swift', urlDepth: 2, abstractText: `A ${t} that manages ${TERMS[(i * 3) % TERMS.length]} for the ${fw} view layer.` })
    }
  db.close()
}
async function waitHealthz() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) { await r.text(); return } } catch {}
    await Bun.sleep(80)
  }
  throw new Error('never healthy')
}
async function ab(c) {
  const p = Bun.spawn(['ab', '-k', '-c', String(c), '-n', String(N), `http://127.0.0.1:${PORT}/search?${QUERY}`], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return { rps: Math.round(Number(out.match(/Requests per second:\s+([\d.]+)/)?.[1] ?? 0)), p50: Number(out.match(/\s+50%\s+(\d+)/)?.[1] ?? 0), failed: Number(out.match(/Failed requests:\s+(\d+)/)?.[1] ?? 0) }
}
async function run(serving) {
  const srv = Bun.spawn([AD_SERVER, '--db', dbPath, '--port', String(PORT), '--threads', String(THREADS), '--loops', '2', '--serving', serving], { stdout: 'ignore', stderr: 'ignore' })
  try {
    await waitHealthz()
    // Spot-parity: both servings run Cascade.search, so the body must match.
    const body = await (await fetch(`http://127.0.0.1:${PORT}/search?${QUERY}`)).text()
    await ab(8) // warm
    const cells = []
    for (const c of CS) { const r = await ab(c); cells.push(`${String(r.rps).padStart(5)} (${String(r.p50).padStart(2)})${r.failed ? '!' : ''}`) }
    return { cells, bodyLen: body.length, body }
  } finally { srv.kill(); await srv.exited; await Bun.sleep(200) }
}

try {
  console.log(`\n=== serving model head-to-head (identical work; threads=${THREADS}, ab -k n=${N}, ${QUERY}) ===`)
  console.log(`  model    │  ${CS.map((c) => `c=${c} rps(p50)`).join('   ')}`)
  const classic = await run('classic')
  const asyncR = await run('async')
  console.log(`  classic  │  ${classic.cells.join('   ')}`)
  console.log(`  async    │  ${asyncR.cells.join('   ')}`)
  console.log(`\n  body parity: ${classic.body === asyncR.body ? 'IDENTICAL' : 'DIFFER'} (classic ${classic.bodyLen}B, async ${asyncR.bodyLen}B)`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

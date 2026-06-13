// Bun comparison server for the P6 host benchmark (RFC 0001 P6). Serves the
// SAME searchPages work as ad-server, two ways, so the burst driver compares
// like-for-like over HTTP:
//   /search-main  → main-thread bun:sqlite db.searchPages          (baseline i)
//   /search-pool  → worker reader pool via runRead (postMessage)   (path ii)
//   /healthz      → static JSON
// Run as a subprocess with APPLE_DOCS_NATIVE=off (pure bun:sqlite, the
// production storage path while native storage is default-off).
//   bun scripts/p6-bun-bench-server.mjs <db> <port> <poolSize>
import { DocsDatabase } from '../src/storage/database.js'
import { createReaderPools } from '../src/storage/reader-pools.js'
import { runRead } from '../src/storage/reader-pool-runread.js'

const dbPath = process.argv[2]
const port = Number(process.argv[3] ?? 3033)
const poolSize = Number(process.argv[4] ?? 6)
if (!dbPath) {
  console.error('usage: bun scripts/p6-bun-bench-server.mjs <db> <port> <poolSize>')
  process.exit(2)
}

const db = new DocsDatabase(dbPath)
const readerPool = createReaderPools({ dbPath, strictSize: poolSize, deepSize: Math.max(1, poolSize >> 1) })
await readerPool.start()
const ctx = { db, readerPool }

function optsFrom(url) {
  const framework = url.searchParams.get('framework')
  return { limit: Number(url.searchParams.get('limit') ?? 100), ...(framework ? { framework } : {}) }
}

Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') return Response.json({ ok: true, service: 'bun-bench' })
    const q = url.searchParams.get('q') ?? ''
    if (url.pathname === '/search-main') {
      return Response.json(db.searchPages(q, q, optsFrom(url)))
    }
    if (url.pathname === '/search-pool') {
      return Response.json(await runRead(ctx, 'searchPages', [q, q, optsFrom(url)]))
    }
    return new Response('not found', { status: 404 })
  },
})
console.log(`bun-bench listening on 127.0.0.1:${port} (pool=${poolSize})`)

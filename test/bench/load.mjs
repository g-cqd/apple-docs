#!/usr/bin/env bun
// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * RFC 0007 F4 — load-test harness (manual tool; NOT a CI test).
 *
 * Spawns the release `ad-server` against a corpus and drives closed-loop concurrent
 * load at target paths, reporting throughput (req/s) + latency percentiles. It isolates
 * the SERVING path — the F4 target — by comparing:
 *   - /healthz  → pure NIO accept + serve + envelope (no pool, no storage)
 *   - /search   → adds the thread-pool offload + ConnectionPool/ConnectionLease + SQLite
 * The gap between the two at high concurrency exposes pool/offload contention (the F4c
 * sharding question). Run before and after each F4 change; keep only measured wins.
 *
 * Usage:
 *   bun test/bench/load.mjs [--db PATH] [--port N] [--threads N] [--secs N] [--no-spawn]
 */
import { existsSync } from 'node:fs'
import { cpus, homedir } from 'node:os'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) continue
  const next = process.argv[i + 1]
  args[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true
}

const DB = args.db ?? `${homedir()}/.apple-docs/apple-docs.db`
const PORT = Number(args.port ?? 3099)
const THREADS = Number(args.threads ?? Math.max(2, cpus().length - 2))
const SECS = Number(args.secs ?? 6)
const BASE = `http://127.0.0.1:${PORT}`
const BIN = new URL('../../swift/.build/release/ad-server', import.meta.url).pathname
const CONCURRENCIES = [16, 128]
const SEARCH = '/search?q=view&framework=swiftui&limit=20'

if (!existsSync(DB)) {
  console.error(`corpus not found: ${DB}`)
  process.exit(2)
}
if (!existsSync(BIN)) {
  console.error(`ad-server not built: ${BIN} — run: swift build -c release`)
  process.exit(2)
}

let server
if (!args['no-spawn']) {
  server = Bun.spawn([BIN, '--db', DB, '--port', String(PORT), '--threads', String(THREADS)], { stdout: 'ignore', stderr: 'ignore' })
}

let ready = false
for (let i = 0; i < 200; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) {
      ready = true
      break
    }
  } catch {}
  await Bun.sleep(50)
}
if (!ready) {
  console.error('server did not become ready')
  server?.kill('SIGKILL')
  process.exit(1)
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0)

async function scenario(label, path, conc) {
  for (let i = 0; i < 100; i++) {
    try {
      await (await fetch(BASE + path)).arrayBuffer()
    } catch {}
  } // warmup
  const url = BASE + path
  const deadline = performance.now() + SECS * 1000
  const lat = []
  let ok = 0,
    err = 0
  async function worker() {
    while (performance.now() < deadline) {
      const t0 = performance.now()
      try {
        const res = await fetch(url)
        await res.arrayBuffer()
        if (res.ok) {
          ok++
          lat.push(performance.now() - t0)
        } else {
          err++
        }
      } catch {
        err++
      }
    }
  }
  const t0 = performance.now()
  await Promise.all(Array.from({ length: conc }, worker))
  const elapsed = (performance.now() - t0) / 1000
  lat.sort((a, b) => a - b)
  console.log(
    `${label.padEnd(22)} conc=${String(conc).padStart(3)}  ${(ok / elapsed).toFixed(0).padStart(7)} req/s  ` +
      `p50=${pct(lat, 50).toFixed(2)} p90=${pct(lat, 90).toFixed(2)} p99=${pct(lat, 99).toFixed(2)} ` +
      `max=${(lat.at(-1) ?? 0).toFixed(1)} ms  ok=${ok} err=${err}`,
  )
}

console.log(`# ad-server load — db=${DB.split('/').at(-1)} threads=${THREADS} secs=${SECS}/scenario`)
for (const conc of CONCURRENCIES) {
  await scenario('/healthz (no pool)', '/healthz', conc)
  await scenario('/search (pool+sqlite)', SEARCH, conc)
}

server?.kill('SIGTERM')
if (server) await Promise.race([server.exited, Bun.sleep(8000)])

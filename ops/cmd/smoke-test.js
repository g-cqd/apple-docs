/**
 * Smoke-test battery for a live apple-docs deploy. Ports
 * ops/bin/smoke-test.sh. Runs three independent checks:
 *
 *  1. Healthz against local + Cloudflare-fronted web/mcp daemons.
 *  2. A burst of 16 search_docs JSON-RPC calls against MCP, with a
 *     ~10ms stagger, to flush out sustained-concurrency regressions
 *     without a synthetic tcp-handshake storm.
 *  3. Five healthz probes scattered through the burst to verify
 *     /healthz keeps returning 2xx while the daemon is busy.
 *
 * The bash version added a warmup call before the burst to prime the
 * reader pool. We do the same — the first cold call can blow the
 * per-op deadline on slow hosts otherwise.
 *
 * Exit code: 0 when every probe + the burst passes; 1 if anything fails.
 * Every probe outcome is logged so the operator-tail looks the same as
 * the bash version (regex-checked by the deploy-update log scraper).
 */

import { loadEnv } from '../lib/env.js'
import { createLogger } from '../lib/logger.js'
import { probe } from '../lib/http-probe.js'

/**
 * @param {{ args?: string[], envLoader?: () => any, logger?: any,
 *           deps?: { fetcher?: typeof fetch, clock?: () => number,
 *                    sleep?: (ms: number) => Promise<void> } }} ctx
 */
export default async function runSmokeTest(ctx = {}) {
  const env = ctx.envLoader ? ctx.envLoader() : loadEnv()
  const logger = ctx.logger ?? createLogger()
  const fetcher = ctx.deps?.fetcher ?? fetch
  const clock = ctx.deps?.clock ?? Date.now
  const sleep = ctx.deps?.sleep ?? defaultSleep

  const burstSize = parseIntEnv(env.vars.SMOKE_BURST_SIZE, 16)
  const burstStaggerMs = parseIntEnv(env.vars.SMOKE_BURST_STAGGER_MS, 10)
  const healthzSamples = parseIntEnv(env.vars.SMOKE_HEALTHZ_SAMPLES, 5)

  let failed = 0

  // 1. Healthz probes.
  const targets = [
    { label: 'local web', url: `http://127.0.0.1:${env.vars.WEB_PORT}/healthz` },
    { label: 'local mcp', url: `http://127.0.0.1:${env.vars.MCP_PORT}/healthz` },
    { label: 'edge  web', url: `https://${env.vars.PUBLIC_WEB_HOST}/healthz` },
    { label: 'edge  mcp', url: `https://${env.vars.PUBLIC_MCP_HOST}/healthz` },
  ]
  for (const t of targets) {
    const r = await probe(t.url, { deadlineMs: 10_000, deps: { fetcher, clock } })
    const status = r.status ?? r.outcome
    const ok2xx = typeof r.status === 'number' && r.status >= 200 && r.status < 400
    logger.say(`${t.label.padEnd(10)} ${t.url} -> HTTP ${status}`)
    if (!ok2xx) failed++
  }

  // 2 + 3. Concurrency probe.
  logger.say('')
  logger.say(
    `concurrency probe (${burstSize}x search_docs staggered ${burstStaggerMs}ms + healthz sampling):`,
  )
  const mcpEndpoint = `http://127.0.0.1:${env.vars.MCP_PORT}/mcp`

  // Warmup so the first burst request doesn't pay cold-cache cost.
  await issueSearchDocs(mcpEndpoint, 'smoke-warmup', 0, { fetcher, deadlineMs: 15_000 })
    .catch(() => {}) // never count warmup against the smoke

  // Fan out the burst with a stagger; sample /healthz alongside.
  const reqPromises = []
  for (let i = 1; i <= burstSize; i++) {
    const query = `probe-${i}-${clock()}`
    reqPromises.push(issueSearchDocs(mcpEndpoint, query, i, { fetcher, deadlineMs: 30_000 }))
    if (burstStaggerMs > 0 && i < burstSize) await sleep(burstStaggerMs)
  }

  let hzOk = 0
  const hzCodes = []
  for (let i = 0; i < healthzSamples; i++) {
    const r = await probe(`http://127.0.0.1:${env.vars.MCP_PORT}/healthz`, {
      deadlineMs: 3_000,
      deps: { fetcher, clock },
    })
    const code = r.status ?? r.outcome
    hzCodes.push(String(code))
    if (typeof r.status === 'number' && r.status >= 200 && r.status < 300) hzOk++
    await sleep(200)
  }
  logger.say(
    `  healthz during burst -> ${hzOk}/${healthzSamples} 2xx [${hzCodes.join(' ')}]`,
  )
  if (hzOk === 0) failed++

  const burstResults = await Promise.all(reqPromises.map(p => p.catch(err => ({ error: err }))))
  let burstFail = 0
  for (let i = 0; i < burstResults.length; i++) {
    const r = burstResults[i]
    const ok2xx = r.status && r.status >= 200 && r.status < 300
    if (!ok2xx) {
      burstFail++
      logger.say(`  req ${i + 1} failed: HTTP ${r.status ?? r.error?.message ?? '000'}`)
    }
  }
  logger.say(`  burst: ${burstSize} requests, ${burstFail} failures`)
  if (burstFail > 0) failed++

  return failed > 0 ? 1 : 0
}

async function issueSearchDocs(url, query, id, { fetcher, deadlineMs }) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'search_docs', arguments: { query, limit: 5 } },
  })
  const r = await probe(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body,
    deadlineMs,
    deps: { fetcher },
  })
  return { status: r.status, outcome: r.outcome }
}

function defaultSleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function parseIntEnv(s, fallback) {
  const n = Number.parseInt(String(s ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

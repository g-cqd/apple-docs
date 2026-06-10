/**
 * Smoke-test battery for a live apple-docs deploy. Ports
 * ops/bin/smoke-test.sh. Runs a readiness gate plus three checks:
 *
 *  0. Bounded readiness wait on the LOCAL daemons. Deploy flows call
 *     smoke seconds after a cutover or a long `web build` releases the
 *     DB lock, while launchd is still restart-throttling a daemon that
 *     crash-looped on SQLITE_BUSY_RECOVERY during the build — a
 *     point-in-time probe at that instant reports 503 on a deploy that
 *     converges moments later. Waiting (default ≤180 s, poll 5 s)
 *     makes smoke assert the converged state; if the wait times out
 *     the assertions below still run and fail honestly.
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
  const readyTimeoutMs = parseIntEnv(env.vars.SMOKE_READY_TIMEOUT_MS, 180_000)
  const readyPollMs = parseIntEnv(env.vars.SMOKE_READY_POLL_MS, 5_000)

  let failed = 0

  // 0. Readiness gate on the local daemons (edge follows once local is up).
  await waitForLocalReadiness({
    urls: [
      `http://127.0.0.1:${env.vars.WEB_PORT}/healthz`,
      `http://127.0.0.1:${env.vars.MCP_PORT}/healthz`,
    ],
    timeoutMs: readyTimeoutMs,
    pollMs: readyPollMs,
    logger,
    deps: { fetcher, clock, sleep },
  })

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

/**
 * Poll the local healthz endpoints until every one answers 2xx/3xx or
 * the attempt budget runs out. Attempt-bounded (not wall-clock-bounded)
 * so injected test clocks/sleeps cannot spin it forever. Never fails
 * the smoke by itself — the assertions that follow do that honestly.
 */
async function waitForLocalReadiness({ urls, timeoutMs, pollMs, logger, deps }) {
  const { fetcher, clock, sleep } = deps
  const start = clock()
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollMs))
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const results = await Promise.all(
      urls.map(u => probe(u, { deadlineMs: 5_000, deps: { fetcher, clock } })),
    )
    const pending = urls.filter((_, i) => {
      const s = results[i].status
      return !(typeof s === 'number' && s >= 200 && s < 400)
    })
    if (pending.length === 0) {
      if (attempt > 1) {
        logger.say(`local daemons ready after ${Math.round((clock() - start) / 1000)}s (${attempt} probes)`)
      }
      return true
    }
    if (attempt === maxAttempts) break
    if (attempt === 1 || attempt % 6 === 0) {
      logger.say(`waiting for local readiness (attempt ${attempt}/${maxAttempts}): ${pending.join(', ')}`)
    }
    await sleep(pollMs)
  }
  logger.warn(`local daemons not ready after ~${Math.round(timeoutMs / 1000)}s — asserting current state`)
  return false
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

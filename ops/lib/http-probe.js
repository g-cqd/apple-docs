/**
 * HTTP probe used by smoke-test.js + watchdog.js for healthz / readyz
 * checks and a few targeted API probes. Bounds every request with a
 * hard deadline, captures the body up to a cap, and returns a
 * structured outcome so the caller can decide how to react.
 *
 * Replaces ad-hoc `curl --fail -m 5 ...` invocations the bash scripts
 * sprinkled everywhere. Using `fetch` directly gives us:
 *  - injectable in tests (no real network)
 *  - structured timeout via AbortController (not curl's signal soup)
 *  - one body-size cap that applies whether the upstream sends
 *    "OK\n" or 100 MB of stack-trace HTML
 */

const DEFAULT_DEADLINE_MS = 5_000
const DEFAULT_BODY_MAX_BYTES = 32 * 1024

/**
 * @typedef {Object} ProbeOptions
 * @property {number} [expectedStatus=200]
 * @property {number} [deadlineMs=5000]
 * @property {number} [bodyMaxBytes=32768]
 * @property {'GET' | 'HEAD' | 'POST'} [method='GET']
 * @property {Record<string, string>} [headers]
 * @property {string} [body]
 * @property {{ fetcher?: typeof fetch, clock?: () => number }} [deps]
 *
 * @typedef {Object} ProbeResult
 * @property {boolean} ok                  status matched expected
 * @property {number | null} status        null when the request never resolved
 * @property {number} elapsedMs
 * @property {string} body                 truncated to bodyMaxBytes
 * @property {'http' | 'timeout' | 'network'} outcome
 * @property {string} url
 * @property {string} [error]              reason text for non-http outcomes
 */

/**
 * Probe an HTTP endpoint. Never throws — always resolves to a
 * structured ProbeResult so the caller can aggregate.
 *
 * @param {string} url
 * @param {ProbeOptions} [opts]
 * @returns {Promise<ProbeResult>}
 */
export async function probe(url, opts = {}) {
  const deps = opts.deps ?? {}
  const fetcher = deps.fetcher ?? fetch
  const clock = deps.clock ?? Date.now

  const expectedStatus = opts.expectedStatus ?? 200
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS
  const bodyMaxBytes = opts.bodyMaxBytes ?? DEFAULT_BODY_MAX_BYTES
  const method = opts.method ?? 'GET'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deadlineMs)
  const startedAt = clock()

  try {
    const res = await fetcher(url, {
      method,
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    })
    const status = res.status
    const body = await readBodyCapped(res, bodyMaxBytes)
    const elapsedMs = clock() - startedAt
    return {
      ok: status === expectedStatus,
      status,
      elapsedMs,
      body,
      outcome: 'http',
      url,
    }
  } catch (err) {
    const elapsedMs = clock() - startedAt
    const aborted = err?.name === 'AbortError' || /aborted/i.test(err?.message ?? '')
    return {
      ok: false,
      status: null,
      elapsedMs,
      body: '',
      outcome: aborted ? 'timeout' : 'network',
      url,
      error: err?.message ?? String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run a batch of probes (sequential). Sequential, not parallel,
 * because the bash smoke-test traced "burst: N requests" sequentially
 * to keep the receiving service from being load-tested under deploy
 * pressure. Returns the aggregate {passed, failed, total, results}.
 *
 * @param {Array<{ url: string } & ProbeOptions>} specs
 * @param {{ fetcher?: typeof fetch, clock?: () => number, logger?: any }} [deps]
 */
export async function probeBatch(specs, deps = {}) {
  const results = []
  for (const spec of specs) {
    const r = await probe(spec.url, { ...spec, deps })
    deps.logger?.say?.(formatProbeLine(r))
    results.push(r)
  }
  const passed = results.filter(r => r.ok).length
  return {
    passed,
    failed: results.length - passed,
    total: results.length,
    results,
  }
}

/**
 * One-liner formatter for human-tailed logs. Matches the bash
 * smoke-test output closely enough that the existing log scrapers
 * keep working.
 */
export function formatProbeLine(r) {
  const stat = r.status ?? r.outcome
  return `  ${r.ok ? '✓' : '✗'} ${r.url} → ${stat} (${r.elapsedMs}ms${r.error ? ` — ${r.error}` : ''})`
}

async function readBodyCapped(res, max) {
  if (!res.body) {
    try { return (await res.text()).slice(0, max) } catch { return '' }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let out = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (received + value.byteLength > max) {
      const room = max - received
      if (room > 0) out += decoder.decode(value.subarray(0, room), { stream: true })
      try { reader.cancel() } catch {}
      break
    }
    received += value.byteLength
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

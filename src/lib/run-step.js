/**
 * Orchestrator phase helper. Wraps a labeled async step in:
 *   - structured-log start / end records (level: info / warn)
 *   - duration accounting in milliseconds
 *   - explicit `{ ok, ms }` envelope so the caller can branch without
 *     a try/catch of its own
 *
 * Distinct from `lib/safe-call.js`, which is a generic error boundary
 * with a default-value fallback (different shape and intent). Prefer
 * `runStep` in command / build orchestrators where each phase has a
 * stable name and the caller wants per-phase metrics.
 *
 * Usage:
 *
 *   const idx = await runStep('body-index', async () => indexBodyIncremental(db, dataDir, logger), { logger })
 *   if (!idx.ok) failedSources.push({ source: 'body-index', error: idx.error.message })
 *
 * The `onError` mode controls failure propagation:
 *   - 'continue' (default): swallow the error, return `{ ok: false, error }`.
 *   - 'throw'             : rethrow after logging — useful when the
 *                           caller wants to abort the orchestrator on a
 *                           specific phase.
 */

/**
 * @template T
 * @param {string} label
 * @param {() => Promise<T> | T} fn
 * @param {{ logger?: { info?: Function, warn?: Function }, onError?: 'continue' | 'throw' }} [opts]
 * @returns {Promise<{ ok: true, label: string, result: T, ms: number } | { ok: false, label: string, error: Error, ms: number }>}
 */
export async function runStep(label, fn, opts = {}) {
  const { logger, onError = 'continue' } = opts
  const start = Date.now()
  try {
    const result = await fn()
    const ms = Date.now() - start
    logger?.info?.(`${label} ok`, { ms })
    return { ok: true, label, result, ms }
  } catch (err) {
    const ms = Date.now() - start
    const error = err instanceof Error ? err : new Error(String(err))
    logger?.warn?.(`${label} failed`, { error: error.message, ms })
    if (onError === 'throw') throw error
    return { ok: false, label, error, ms }
  }
}

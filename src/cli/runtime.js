/**
 * Entry-point runtime helpers: flag coercion shared by several commands
 * and the per-host rate limiter every command's ctx carries.
 *
 * Lives beside the dispatcher rather than inside it so `cli.js` stays a
 * routing table — it is the one file the 400-line ceiling has no slack in,
 * since every new command adds a case.
 */

import { config } from '../config.js'
import { createHostBucketedLimiter } from '../lib/per-host-rate-limiter.js'

/** Parse a flag as an int, or undefined when absent/unparseable. */
export function parseOptionalInt(value) {
  if (value == null) return undefined
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : undefined
}

/** metrics-port/host on `mcp serve` + `web serve`. Spread into opts. */
export function metricsOpts(flags) {
  const p = parseOptionalInt(flags['metrics-port'])
  return { ...(p != null && { metricsPort: p }), ...(flags['metrics-host'] && { metricsHost: flags['metrics-host'] }) }
}

/**
 * Build the per-host rate limiter for a command.
 *
 * Per-host buckets only — no `primary` global bucket. A primary equal to a
 * single host's rate serialized every host (Apple CDN, GitHub, swift.org)
 * through one token stream: while the apple-docc check phase saturated it,
 * every other adapter's bucket sat idle, and the token dispenser's ~2ms
 * setTimeout granularity capped the whole sync at ~440 req/s.
 *
 * @param {{ command: string, flags: Record<string, any> }} input
 * @returns {{ rateLimiter: object, rate: number, burst: number }}
 */
export function createRateLimiter({ command, flags }) {
  const isCrawlCommand = command === 'sync'
  const defaultRate = isCrawlCommand ? 500 : 5
  const defaultBurst = isCrawlCommand ? 500 : 2
  const rate = flags.rate != null ? Number.parseInt(flags.rate, 10) : (config.APPLE_DOCS_RATE ?? defaultRate)
  const burst = Math.max(rate, config.APPLE_DOCS_BURST ?? defaultBurst)
  return { rateLimiter: createHostBucketedLimiter({ defaults: { rate, burst } }), rate, burst }
}

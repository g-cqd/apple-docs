/**
 * Wipe the Cloudflare edge cache for the apple-docs zone.
 *
 * Ports ops/bin/cf-purge.sh. Soft-fails (exit 0 + warn) when the
 * Cloudflare token/zone isn't configured — that's the dev-machine
 * default and we don't want to block a deploy on it. Returns non-zero
 * only when the token IS set but the API call returned an error.
 *
 * Cloudflare's `purge_everything` is single-call and single quota
 * slot — refreshes API JSON + static HTML + search artifacts in one
 * shot. The single Mac mini deploy cadence is well below the rate
 * limit so we don't bother enumerating URLs.
 *
 * Token + zone are read from env:
 *   CLOUDFLARE_API_TOKEN  scoped to Zone.Cache Purge on the one zone
 *   CLOUDFLARE_ZONE_ID    target zone
 *
 * CLI shape: ops/cli.js cf-purge
 *
 * Exit codes:
 *   0  purge succeeded OR token/zone not configured (warned)
 *   1  configured but the API call returned a non-success payload
 */

import { loadEnv } from '../lib/env.js'
import { createLogger } from '../lib/logger.js'
import { probe } from '../lib/http-probe.js'

const API_BASE = 'https://api.cloudflare.com/client/v4'

/**
 * @param {{ args?: string[], env?: Record<string,string>,
 *           envLoader?: () => any, logger?: any,
 *           deps?: { fetcher?: typeof fetch } }} ctx
 * @returns {Promise<number>}
 */
export default async function runCfPurge(ctx = {}) {
  const logger = ctx.logger ?? createLogger()
  const fetcher = ctx.deps?.fetcher ?? fetch

  // Read CF creds from process env first (they may be passed in by a
  // CI runner without landing in ops/.env), then fall back to the
  // ops/.env-derived bag.
  const procEnv = ctx.env ?? process.env
  let opsVars = procEnv
  if (!procEnv.CLOUDFLARE_API_TOKEN || !procEnv.CLOUDFLARE_ZONE_ID) {
    try {
      const env = ctx.envLoader ? ctx.envLoader() : loadEnv()
      opsVars = { ...env.vars, ...procEnv }
    } catch {
      // No ops/.env or it's invalid — that's fine, we'll fall through
      // to the "token not set → soft fail" branch.
    }
  }

  const token = opsVars.CLOUDFLARE_API_TOKEN
  const zone = opsVars.CLOUDFLARE_ZONE_ID

  if (!token || !zone) {
    logger.warn(
      'CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID not set — skipping edge purge. ' +
      'Stale /api/search and /api/filters may persist at the edge for up to 5 min.',
    )
    return 0
  }

  logger.say(`purging zone ${zone.slice(0, 8)}…`)
  const url = `${API_BASE}/zones/${encodeURIComponent(zone)}/purge_cache`
  const result = await probe(url, {
    method: 'POST',
    expectedStatus: 200,
    deadlineMs: 30_000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ purge_everything: true }),
    deps: { fetcher },
  })

  if (!result.ok) {
    logger.error(`Cloudflare purge failed: ${result.outcome} status=${result.status}`)
    if (result.body) logger.error(result.body.slice(0, 512))
    return 1
  }
  // Cloudflare may return HTTP 200 with success:false on auth /
  // permission failures. Parse the body and double-check.
  let body
  try { body = JSON.parse(result.body) } catch { body = null }
  if (!body || body.success !== true) {
    logger.error('Cloudflare purge response did not report success')
    if (result.body) logger.error(result.body.slice(0, 512))
    return 1
  }
  logger.say('purge ok')
  return 0
}

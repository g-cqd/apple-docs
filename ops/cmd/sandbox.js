/**
 * `ops/cli.js sandbox status` — report whether the web and MCP daemons are
 * confined by the Seatbelt profile (ops/sandbox/apple-docs-serve.sb).
 *
 * Each server probes its own confinement (src/lib/sandbox-probe.js) and
 * reports it in the local `/healthz` body, so this command asks the loopback
 * backends instead of inspecting the kernel. Edge requests never see the
 * field; this command sends none of the Cloudflare headers.
 *
 * Exit status: 0 when every backend is confined, or when `SANDBOX_SERVE=off`
 * (an explicit choice, reported as such); 1 when the sandbox is configured on
 * and any backend is not confined, unreachable, or does not report (a server
 * older than this check cannot be verified).
 */

import { loadEnv } from '../lib/env.js'
import { createLogger } from '../lib/logger.js'
import { probe } from '../lib/http-probe.js'

/** @typedef {'confined' | 'NOT confined' | 'unknown' | 'unreachable'} Verdict */

/**
 * Turn a `/healthz` probe result into a verdict.
 *
 * @param {{ ok: boolean, body: string }} result
 * @returns {Verdict}
 */
export function verdictFrom(result) {
  if (!result.ok) return 'unreachable'
  let body
  try {
    body = JSON.parse(result.body)
  } catch {
    return 'unknown'
  }
  if (body?.sandboxed === true) return 'confined'
  if (body?.sandboxed === false) return 'NOT confined'
  return 'unknown'
}

/**
 * @param {{ args?: string[], envLoader?: () => any, logger?: any,
 *           deps?: { probe?: typeof probe } }} ctx
 * @returns {Promise<number>}
 */
export default async function runSandbox(ctx = {}) {
  const logger = ctx.logger ?? createLogger()
  const verb = (ctx.args ?? [])[0] ?? 'status'
  if (verb !== 'status') {
    logger.error(`sandbox: unknown verb "${verb}" (usage: sandbox status)`)
    return 64
  }

  const env = ctx.envLoader ? ctx.envLoader() : loadEnv()
  const run = ctx.deps?.probe ?? probe
  const configured = env.vars.SANDBOX_SERVE
  const backends = [
    ['web', env.vars.WEB_BACKEND_PORT],
    ['mcp', env.vars.MCP_BACKEND_PORT],
  ]

  logger.say(`SANDBOX_SERVE=${configured}${env.vars.SANDBOX_SERVE === 'on' ? '' : ' (sandbox disabled by configuration)'}`)
  let failures = 0
  for (const [name, port] of backends) {
    const url = `http://127.0.0.1:${port}/healthz`
    const verdict = verdictFrom(await run(url, { deadlineMs: 5_000 }))
    logger.say(`  ${name.padEnd(4)} ${url.padEnd(34)} ${verdict}`)
    if (verdict !== 'confined') failures++
  }
  if (configured === 'off') return 0
  if (failures > 0) logger.warn(`sandbox: ${failures} backend(s) not confirmed confined while SANDBOX_SERVE=on`)
  return failures > 0 ? 1 : 0
}

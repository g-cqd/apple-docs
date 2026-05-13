/**
 * Long-running guardrail for the apple-docs deployment. Ports
 * ops/bin/watchdog.sh.
 *
 * Defends the deployment from four failure modes launchd KeepAlive
 * cannot catch on its own:
 *
 *   1. Bun event-loop wedge — process listening but accept() starved.
 *      Detected by polling /readyz on the *backend* port (bypassing
 *      Caddy, which would still serve static for a wedged backend) and
 *      counting consecutive failures.
 *   2. Slow accumulation — observed at +5 days uptime. Mitigated by an
 *      optional daily kickstart at WATCHDOG_DAILY_RESTART_HOUR.
 *   3. RSS runaway — pure backstop above any healthy baseline.
 *   4. Operator absence — restarts run unattended with a cooldown to
 *      avoid restart storms.
 *
 * Body match: a 2xx with `"ok": true` somewhere in the JSON counts as
 * healthy. Guards against another local process squatting the loopback
 * port and serving a generic 200.
 *
 * Cooldown stamping order: the per-backend stamp is written BEFORE the
 * launchctl call, not after. If the watchdog itself is killed (e.g. by
 * deploy-update kickstarting LABEL_WATCHDOG) between the launchctl
 * call and the stamp write, the next watchdog instance would otherwise
 * see last_restart=0 and immediately re-kickstart — doubling the
 * user-visible blip. Stamping first means worst case we miss one
 * restart; the next probe failure within COOLDOWN will retry.
 *
 * RSS check: pgrep must return exactly one pid. During kickstart races
 * (old bun still SIGKILL-ing while new one spawned) we cannot tell
 * which RSS belongs to the live backend — skip until pgrep is stable.
 *
 * Daily restart: stamped per yyyymmdd; stamp is written ONLY on
 * successful kickstart so a transient cooldown collision at the daily
 * hour does not suppress the restart for the rest of the day.
 *
 * CLI shape: ops/cli.js watchdog  (no flags; configured via env.)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from '../lib/env.js'
import { createLogger } from '../lib/logger.js'
import { runCmdAllowFailure } from '../lib/run-cmd.js'

const SUDO = '/usr/bin/sudo'
const LAUNCHCTL = '/bin/launchctl'

/**
 * @param {{ args?: string[], env?: Record<string,string>,
 *           envLoader?: () => any, logger?: any, signal?: AbortSignal,
 *           deps?: { now?: () => number,
 *                    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *                    probeReadyz?: (url: string, timeoutMs: number) => Promise<{ok:boolean, status:number}>,
 *                    psLookup?: (pattern: string) => Promise<{rssMb:number, pidCount:number}>,
 *                    kickstart?: (label: string) => Promise<any>,
 *                    fs?: { exists: Function, read: Function, write: Function, mkdirp: Function },
 *                    maxIterations?: number } }} ctx
 */
export default async function runWatchdog(ctx = {}) {
  const env = ctx.envLoader ? ctx.envLoader() : loadEnv()
  const procEnv = ctx.env ?? process.env
  const logger = ctx.logger ?? createLogger({ logPath: join(env.opsDir, 'logs', 'watchdog.log') })
  const deps = ctx.deps ?? {}

  const cfg = {
    intervalMs:    Number(procEnv.WATCHDOG_INTERVAL ?? 30) * 1000,
    failsBudget:   Number(procEnv.WATCHDOG_FAILS ?? 3),
    probeTimeoutMs: Number(procEnv.WATCHDOG_TIMEOUT ?? 5) * 1000,
    cooldownMs:    Number(procEnv.WATCHDOG_COOLDOWN ?? 300) * 1000,
    webRssCapMb:   Number(procEnv.WATCHDOG_WEB_RSS_LIMIT_MB ?? 3072),
    mcpRssCapMb:   Number(procEnv.WATCHDOG_MCP_RSS_LIMIT_MB ?? 8192),
    dailyHour:     procEnv.WATCHDOG_DAILY_RESTART_HOUR
                     ? Number(procEnv.WATCHDOG_DAILY_RESTART_HOUR) : null,
    dailyTargets:  (procEnv.WATCHDOG_DAILY_RESTART_TARGETS ?? 'web')
                     .split(',').map(s => s.trim()).filter(Boolean),
  }

  const backends = {
    web: {
      label: env.labels.web,
      url: `http://127.0.0.1:${env.vars.WEB_BACKEND_PORT}/readyz`,
      rssCapMb: cfg.webRssCapMb,
      psPattern: `${env.repoDir}/cli.js web serve`,
    },
    mcp: {
      label: env.labels.mcp,
      url: `http://127.0.0.1:${env.vars.MCP_BACKEND_PORT}/readyz`,
      rssCapMb: cfg.mcpRssCapMb,
      psPattern: `${env.repoDir}/cli.js mcp serve`,
    },
  }

  const fs = deps.fs ?? defaultFs()
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? defaultSleep
  const probe = deps.probeReadyz ?? defaultProbe
  const psLookup = deps.psLookup ?? defaultPsLookup
  const kickstart = deps.kickstart ?? defaultKickstart
  const signal = ctx.signal
  const maxIterations = deps.maxIterations ?? Infinity

  const stateDir = join(env.opsDir, 'logs', '.watchdog')
  fs.mkdirp(stateDir, 0o700)

  const state = { fails: { web: 0, mcp: 0 } }

  logger.say(
    `watchdog starting (interval=${cfg.intervalMs / 1000}s, fails=${cfg.failsBudget}, ` +
    `timeout=${cfg.probeTimeoutMs / 1000}s, cooldown=${cfg.cooldownMs / 1000}s, ` +
    `daily_hour=${cfg.dailyHour ?? 'off'})`,
  )

  const tickDeps = { cfg, fs, stateDir, probe, psLookup, kickstart, now, logger, state }

  let iterations = 0
  while (!signal?.aborted && iterations < maxIterations) {
    iterations += 1
    for (const name of ['web', 'mcp']) {
      await probeOne(name, backends[name], tickDeps)
      await checkRss(name, backends[name], tickDeps)
    }
    if (cfg.dailyHour !== null) {
      await dailyRestartCheck(backends, tickDeps)
    }
    if (signal?.aborted || iterations >= maxIterations) break
    await sleep(cfg.intervalMs, signal)
  }
  logger.say('watchdog stopping')
  return 0
}

async function probeOne(name, b, d) {
  let result
  try {
    result = await d.probe(b.url, d.cfg.probeTimeoutMs)
  } catch (err) {
    result = { ok: false, status: 0, error: String(err?.message ?? err) }
  }
  if (result.ok) {
    d.state.fails[name] = 0
    return
  }
  d.state.fails[name] = (d.state.fails[name] ?? 0) + 1
  d.logger.say(
    `${name} healthz probe failed (HTTP ${result.status || 0}, fail ${d.state.fails[name]}/${d.cfg.failsBudget})`,
  )
  if (d.state.fails[name] >= d.cfg.failsBudget) {
    const fired = await maybeKickstart(
      name, b.label,
      `${d.state.fails[name]} consecutive /readyz failures (last status ${result.status || 0})`,
      d,
    )
    if (fired) d.state.fails[name] = 0
  }
}

async function checkRss(name, b, d) {
  if (!b.rssCapMb || b.rssCapMb <= 0) return
  let info
  try {
    info = await d.psLookup(b.psPattern)
  } catch (err) {
    d.logger.warn(`${name} ps lookup failed: ${err?.message ?? err}`)
    return
  }
  if (!info || info.pidCount === 0) return
  if (info.pidCount > 1) {
    d.logger.warn(`${name} RSS check skipped — ${info.pidCount} pids match '${b.psPattern}'`)
    return
  }
  if (info.rssMb > b.rssCapMb) {
    await maybeKickstart(name, b.label, `RSS ${info.rssMb}MB > ${b.rssCapMb}MB cap`, d)
  }
}

async function dailyRestartCheck(backends, d) {
  const date = new Date(d.now())
  if (date.getHours() !== d.cfg.dailyHour) return
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const today = `${y}${m}${day}`
  const stamp = join(d.stateDir, `daily_${today}.done`)
  if (d.fs.exists(stamp)) return

  let didRestart = false
  for (const t of d.cfg.dailyTargets) {
    if (!/^[a-z]+$/.test(t)) { d.logger.warn(`skipping malformed target '${t}'`); continue }
    const b = backends[t]
    if (!b) {
      d.logger.warn(`WATCHDOG_DAILY_RESTART_TARGETS includes unknown target '${t}' — skipping`)
      continue
    }
    const fired = await maybeKickstart(
      t, b.label, `daily preventive restart (hour ${d.cfg.dailyHour})`, d,
    )
    if (fired) didRestart = true
  }
  if (didRestart) d.fs.write(stamp, '')
}

async function maybeKickstart(name, label, reason, d) {
  const lastFile = join(d.stateDir, `${name}.last_restart`)
  const last = readInt(d.fs, lastFile)
  const t = d.now()
  if (t - last < d.cfg.cooldownMs) {
    const remaining = Math.ceil((d.cfg.cooldownMs - (t - last)) / 1000)
    d.logger.say(`skip ${name} kickstart (cooldown ${remaining}s remaining): ${reason}`)
    return false
  }
  d.logger.say(`kickstart ${name} (${label}): ${reason}`)
  // Stamp BEFORE the call: see the file-level comment.
  d.fs.write(lastFile, String(t))
  try {
    await d.kickstart(label)
    return true
  } catch (err) {
    d.logger.error(`sudo launchctl kickstart failed for ${label}: ${err?.message ?? err}`)
    return false
  }
}

function readInt(fs, p) {
  if (!fs.exists(p)) return 0
  const v = (fs.read(p) ?? '').trim()
  return /^\d+$/.test(v) ? Number(v) : 0
}

async function defaultProbe(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: controller.signal })
    const text = await r.text()
    const ok = r.status >= 200 && r.status < 300 && /"ok"\s*:\s*true/.test(text)
    return { ok, status: r.status }
  } catch {
    return { ok: false, status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

async function defaultPsLookup(pattern) {
  const r = await runCmdAllowFailure(['/usr/bin/pgrep', '-f', pattern], { deadlineMs: 5_000 })
  const pids = (r.stdout ?? '').split('\n').map(s => s.trim()).filter(Boolean)
  if (pids.length === 0) return { rssMb: 0, pidCount: 0 }
  if (pids.length > 1) return { rssMb: 0, pidCount: pids.length }
  const ps = await runCmdAllowFailure(['/bin/ps', '-o', 'rss=', '-p', pids[0]], { deadlineMs: 5_000 })
  const rssKb = Number((ps.stdout ?? '').trim()) || 0
  return { rssMb: Math.floor(rssKb / 1024), pidCount: 1 }
}

async function defaultKickstart(label) {
  return runCmdAllowFailure(
    [SUDO, '-n', LAUNCHCTL, 'kickstart', '-k', `system/${label}`],
    { deadlineMs: 15_000 },
  )
}

function defaultSleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

function defaultFs() {
  return {
    exists: existsSync,
    read: (p) => readFileSync(p, 'utf8'),
    write: (p, c) => writeFileSync(p, c),
    mkdirp: (p, mode = 0o700) => {
      if (!existsSync(p)) mkdirSync(p, { recursive: true, mode })
      try { chmodSync(p, mode) } catch { /* ignore */ }
    },
  }
}

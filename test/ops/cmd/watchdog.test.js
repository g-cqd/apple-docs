import { describe, test, expect } from 'bun:test'
import runWatchdog from '../../../ops/cmd/watchdog.js'

function captureLogger() {
  const lines = []
  return {
    lines,
    say: m => lines.push(m),
    warn: m => lines.push('W:' + m),
    error: m => lines.push('E:' + m),
    runOutput: () => {},
  }
}

const ENV = {
  opsDir: '/fake/ops',
  repoDir: '/fake/repo',
  bunBin: '/usr/local/bin/bun',
  dataDir: '/fake/data',
  staticDir: '/fake/repo/dist/web',
  vars: {
    WEB_BACKEND_PORT: '4130',
    MCP_BACKEND_PORT: '4131',
  },
  labels: {
    web: 'mt.test.web', mcp: 'mt.test.mcp', watchdog: 'mt.test.watchdog',
    proxy: 'mt.test.proxy', tunnelWeb: 'mt.test.cf.web', tunnelMcp: 'mt.test.cf.mcp',
  },
}

// In-memory fs with the same shape as ops/cmd/watchdog.js#defaultFs.
function inMemoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    exists: (p) => files.has(p),
    read: (p) => files.get(p) ?? '',
    write: (p, c) => { files.set(p, c) },
    mkdirp: () => {},
  }
}

// A fake clock advanced manually by the test. Storing a function pointer
// behind `.now` lets tests bump it in-place via the returned handle.
function fakeClock(start = 0) {
  const handle = { now: start }
  return { ...handle, fn: () => handle.now, set: t => { handle.now = t }, advance: ms => { handle.now += ms } }
}

// Scripted probe: round-robin through `outcomes`. When exhausted,
// reuses the last entry. `outcomes` is an array of either:
//   - { ok: true, status: 200 }
//   - { ok: false, status: 503 }
function scriptedProbe(outcomes) {
  const calls = []
  let i = 0
  const fn = async (url, timeoutMs) => {
    calls.push({ url, timeoutMs, at: i })
    const o = outcomes[Math.min(i, outcomes.length - 1)]
    i += 1
    return o
  }
  return { fn, calls }
}

function fakeKickstart() {
  const calls = []
  const fn = async (label) => { calls.push({ label }); return { exitCode: 0 } }
  return { fn, calls }
}

// Default clock value far past any cooldown so the first kickstart fires
// (matches bash semantics: `date +%s` is always >> cooldown). Tests that
// pin a specific time pass their own `now`.
const DEFAULT_NOW_MS = 1_700_000_000_000

function baseCtx(overrides = {}) {
  const sleeps = []
  const logger = overrides.logger ?? captureLogger()
  return {
    sleeps,
    logger,
    ctx: {
      env: overrides.env ?? {},
      envLoader: () => ENV,
      logger,
      deps: {
        fs: overrides.fs ?? inMemoryFs(),
        now: overrides.now ?? (() => DEFAULT_NOW_MS),
        sleep: async (ms) => { sleeps.push(ms) },
        probeReadyz: overrides.probe ?? scriptedProbe([{ ok: true, status: 200 }]).fn,
        psLookup: overrides.psLookup ?? (async () => ({ rssMb: 0, pidCount: 0 })),
        kickstart: overrides.kickstart ?? fakeKickstart().fn,
        maxIterations: overrides.maxIterations ?? 1,
        ...(overrides.depsExtra ?? {}),
      },
    },
  }
}

describe('runWatchdog', () => {
  test('returns 0 immediately when maxIterations is 0', async () => {
    const { ctx } = baseCtx({ maxIterations: 0 })
    const code = await runWatchdog(ctx)
    expect(code).toBe(0)
  })

  test('healthy probe leaves fail counter at 0 and does not kickstart', async () => {
    const probe = scriptedProbe([{ ok: true, status: 200 }])
    const kick = fakeKickstart()
    const { ctx } = baseCtx({ probe: probe.fn, kickstart: kick.fn })
    await runWatchdog(ctx)
    // Two probes per iteration (web + mcp), one iteration.
    expect(probe.calls.length).toBe(2)
    expect(kick.calls).toEqual([])
  })

  test('accumulates fails below budget without kickstarting', async () => {
    const probe = scriptedProbe([{ ok: false, status: 503 }])
    const kick = fakeKickstart()
    const { ctx, logger } = baseCtx({
      probe: probe.fn, kickstart: kick.fn,
      env: { WATCHDOG_FAILS: '3' },
      maxIterations: 2,
    })
    await runWatchdog(ctx)
    // 2 failed probes per backend < budget 3 → no kickstart yet.
    expect(kick.calls).toEqual([])
    expect(logger.lines.some(m => m.includes('fail 1/3'))).toBe(true)
    expect(logger.lines.some(m => m.includes('fail 2/3'))).toBe(true)
  })

  test('kickstarts after FAILS_BUDGET consecutive failed probes', async () => {
    const probe = scriptedProbe([{ ok: false, status: 503 }])
    const kick = fakeKickstart()
    const { ctx } = baseCtx({
      probe: probe.fn, kickstart: kick.fn,
      env: { WATCHDOG_FAILS: '3' },
      maxIterations: 3,
    })
    await runWatchdog(ctx)
    // Iteration 3 reaches budget for both backends, each kickstarts once.
    const labels = kick.calls.map(c => c.label).sort()
    expect(labels).toEqual(['mt.test.mcp', 'mt.test.web'])
  })

  test('fails counter resets after a successful kickstart', async () => {
    let i = 0
    const fakeProbe = async () => {
      i += 1
      return { ok: false, status: 500 }
    }
    const kick = fakeKickstart()
    const clock = fakeClock(0)
    const { ctx, logger } = baseCtx({
      probe: fakeProbe, kickstart: kick.fn, now: clock.fn,
      env: { WATCHDOG_FAILS: '3', WATCHDOG_COOLDOWN: '0' },
      maxIterations: 4,
    })
    await runWatchdog(ctx)
    // Without reset, iteration 4 would say "fail 4/3"; with reset it
    // shows "fail 1/3" after the kickstart.
    expect(logger.lines.some(m => m.includes('fail 4/3'))).toBe(false)
    // With COOLDOWN=0 every overflow iteration fires another kickstart.
    expect(kick.calls.length).toBeGreaterThanOrEqual(2)
    expect(i).toBeGreaterThan(0)
  })

  test('healthy probe after failures resets the counter (no kickstart)', async () => {
    let probeIdx = 0
    const outcomes = [
      { ok: false, status: 500 }, { ok: false, status: 500 },  // web/mcp it1
      { ok: false, status: 500 }, { ok: false, status: 500 },  // web/mcp it2
      { ok: true, status: 200 },  { ok: true, status: 200 },   // web/mcp it3 (recovered)
    ]
    const probe = async () => outcomes[probeIdx++] ?? { ok: true, status: 200 }
    const kick = fakeKickstart()
    const { ctx } = baseCtx({
      probe, kickstart: kick.fn,
      env: { WATCHDOG_FAILS: '3' },
      maxIterations: 3,
    })
    await runWatchdog(ctx)
    expect(kick.calls).toEqual([])
  })

  test('cooldown stamp is written BEFORE the kickstart call', async () => {
    // Even when the kickstart throws, the stamp must already be on disk:
    // protects against the watchdog being killed mid-kickstart and the
    // next instance double-firing.
    const probe = scriptedProbe([{ ok: false, status: 500 }])
    const kickstart = async () => { throw new Error('kickstart blew up') }
    const fs = inMemoryFs()
    const { ctx } = baseCtx({
      probe: probe.fn, kickstart, fs,
      env: { WATCHDOG_FAILS: '1' },
      maxIterations: 1,
    })
    await runWatchdog(ctx)
    expect(fs.files.has('/fake/ops/logs/.watchdog/web.last_restart')).toBe(true)
    expect(fs.files.has('/fake/ops/logs/.watchdog/mcp.last_restart')).toBe(true)
  })

  test('cooldown blocks back-to-back kickstarts', async () => {
    const probe = scriptedProbe([{ ok: false, status: 500 }])
    const kick = fakeKickstart()
    const fs = inMemoryFs()
    // Frozen clock at DEFAULT_NOW_MS: iter 1 fires, but the stamp it
    // writes equals the current time so iters 2-3 see diff=0 < cooldown.
    const { ctx, logger } = baseCtx({
      probe: probe.fn, kickstart: kick.fn, fs,
      env: { WATCHDOG_FAILS: '1', WATCHDOG_COOLDOWN: '300' },
      maxIterations: 3,
    })
    await runWatchdog(ctx)
    // Iteration 1 fires kickstart for both; 2 & 3 hit cooldown.
    expect(kick.calls.length).toBe(2)
    expect(logger.lines.some(m => m.includes('cooldown') && m.includes('remaining'))).toBe(true)
  })

  test('cooldown expires after WATCHDOG_COOLDOWN seconds (next kickstart fires)', async () => {
    const probe = scriptedProbe([{ ok: false, status: 500 }])
    const kick = fakeKickstart()
    let t = DEFAULT_NOW_MS
    const now = () => t
    const sleep = async () => { t += 301 * 1000 } // advance past 300s cooldown each tick
    const fs = inMemoryFs()
    const { ctx } = baseCtx({
      probe: probe.fn, kickstart: kick.fn, now, fs,
      env: { WATCHDOG_FAILS: '1', WATCHDOG_COOLDOWN: '300' },
      depsExtra: { sleep },
      maxIterations: 3,
    })
    await runWatchdog(ctx)
    // Three iterations, cooldown expires each time → 6 kickstarts (2 per iter).
    expect(kick.calls.length).toBe(6)
  })

  test('RSS check: no matching pid is a silent no-op', async () => {
    const kick = fakeKickstart()
    const psLookup = async () => ({ rssMb: 0, pidCount: 0 })
    const { ctx } = baseCtx({ kickstart: kick.fn, psLookup })
    await runWatchdog(ctx)
    expect(kick.calls).toEqual([])
  })

  test('RSS check skips when more than one pid matches (kickstart race guard)', async () => {
    const kick = fakeKickstart()
    const psLookup = async () => ({ rssMb: 999999, pidCount: 2 })
    const { ctx, logger } = baseCtx({ kickstart: kick.fn, psLookup })
    await runWatchdog(ctx)
    expect(kick.calls).toEqual([])
    expect(logger.lines.some(m => m.startsWith('W:') && m.includes('RSS check skipped'))).toBe(true)
  })

  test('RSS over cap triggers kickstart', async () => {
    const kick = fakeKickstart()
    const psLookup = async (pattern) => {
      // Only the web pattern is over cap.
      if (pattern.endsWith('web serve')) return { rssMb: 4000, pidCount: 1 }
      return { rssMb: 100, pidCount: 1 }
    }
    const { ctx } = baseCtx({ kickstart: kick.fn, psLookup })
    await runWatchdog(ctx)
    expect(kick.calls.map(c => c.label)).toEqual(['mt.test.web'])
  })

  test('RSS under cap does not trigger kickstart', async () => {
    const kick = fakeKickstart()
    const psLookup = async () => ({ rssMb: 100, pidCount: 1 })
    const { ctx } = baseCtx({ kickstart: kick.fn, psLookup })
    await runWatchdog(ctx)
    expect(kick.calls).toEqual([])
  })

  test('daily preventive restart fires at the configured hour and stamps the day', async () => {
    const kick = fakeKickstart()
    const fs = inMemoryFs()
    // Pick a date with hour=4. Use UTC-aware construction by setting a
    // local-time Date instance — the watchdog uses getHours() so we set
    // the local-time hour directly via Date.
    const d = new Date(2026, 4, 12, 4, 30) // May 12 2026, 04:30 local
    const { ctx } = baseCtx({
      kickstart: kick.fn, fs, now: () => d.getTime(),
      env: { WATCHDOG_DAILY_RESTART_HOUR: '4', WATCHDOG_DAILY_RESTART_TARGETS: 'web,mcp' },
    })
    await runWatchdog(ctx)
    const labels = kick.calls.map(c => c.label).sort()
    expect(labels).toEqual(['mt.test.mcp', 'mt.test.web'])
    expect(fs.files.has('/fake/ops/logs/.watchdog/daily_20260512.done')).toBe(true)
  })

  test('daily restart skipped when current hour does not match', async () => {
    const kick = fakeKickstart()
    const d = new Date(2026, 4, 12, 9, 30) // hour 9, not the configured 4
    const { ctx } = baseCtx({
      kickstart: kick.fn, now: () => d.getTime(),
      env: { WATCHDOG_DAILY_RESTART_HOUR: '4' },
    })
    await runWatchdog(ctx)
    expect(kick.calls).toEqual([])
  })

  test('daily restart skipped when stamp file already exists', async () => {
    const kick = fakeKickstart()
    const fs = inMemoryFs({ '/fake/ops/logs/.watchdog/daily_20260512.done': '' })
    const d = new Date(2026, 4, 12, 4, 30)
    const { ctx } = baseCtx({
      kickstart: kick.fn, fs, now: () => d.getTime(),
      env: { WATCHDOG_DAILY_RESTART_HOUR: '4' },
    })
    await runWatchdog(ctx)
    expect(kick.calls).toEqual([])
  })

  test('daily stamp is NOT written when every target hits cooldown', async () => {
    const kick = fakeKickstart()
    const fs = inMemoryFs()
    const d = new Date(2026, 4, 12, 4, 30)
    const t = d.getTime()
    // Pretend a recent kickstart happened 5s ago — cooldown is 300s.
    fs.write('/fake/ops/logs/.watchdog/web.last_restart', String(t - 5_000))
    const { ctx } = baseCtx({
      kickstart: kick.fn, fs, now: () => t,
      env: {
        WATCHDOG_DAILY_RESTART_HOUR: '4',
        WATCHDOG_DAILY_RESTART_TARGETS: 'web',
        WATCHDOG_COOLDOWN: '300',
      },
    })
    await runWatchdog(ctx)
    expect(kick.calls).toEqual([])
    expect(fs.files.has('/fake/ops/logs/.watchdog/daily_20260512.done')).toBe(false)
  })

  test('daily restart rejects malformed and unknown targets, restarts the rest', async () => {
    const kick = fakeKickstart()
    const fs = inMemoryFs()
    const d = new Date(2026, 4, 12, 4, 30)
    const { ctx, logger } = baseCtx({
      kickstart: kick.fn, fs, now: () => d.getTime(),
      env: {
        WATCHDOG_DAILY_RESTART_HOUR: '4',
        WATCHDOG_DAILY_RESTART_TARGETS: 'web, ../oof, bogus',
      },
    })
    await runWatchdog(ctx)
    expect(kick.calls.map(c => c.label)).toEqual(['mt.test.web'])
    expect(logger.lines.some(m => m.includes('malformed'))).toBe(true)
    expect(logger.lines.some(m => m.includes('unknown target'))).toBe(true)
  })

  test('AbortSignal stops the loop between iterations', async () => {
    const probe = scriptedProbe([{ ok: true, status: 200 }])
    const controller = new AbortController()
    let iters = 0
    const sleep = async () => {
      iters += 1
      if (iters >= 2) controller.abort()
    }
    const { ctx } = baseCtx({
      probe: probe.fn,
      depsExtra: { sleep },
      maxIterations: 1_000,
    })
    ctx.signal = controller.signal
    await runWatchdog(ctx)
    // Probe is called twice per iteration; expect at most a few iterations,
    // never the 1000 from maxIterations.
    expect(probe.calls.length).toBeLessThan(20)
  })

  test('probe error is treated as a failed probe (counts toward budget)', async () => {
    const probe = async () => { throw new Error('connection refused') }
    const kick = fakeKickstart()
    const { ctx, logger } = baseCtx({
      probe, kickstart: kick.fn,
      env: { WATCHDOG_FAILS: '2' },
      maxIterations: 2,
    })
    await runWatchdog(ctx)
    // 2 iterations × 2 backends = budget reached → each backend kickstarts once.
    expect(kick.calls.length).toBe(2)
    expect(logger.lines.some(m => m.includes('HTTP 0'))).toBe(true)
  })
})

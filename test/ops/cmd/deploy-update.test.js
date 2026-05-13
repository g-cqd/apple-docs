import { describe, test, expect } from 'bun:test'
import runDeployUpdate from '../../../ops/cmd/deploy-update.js'

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
  staticDir: '/fake/repo/dist/web',
  dataDir: '/fake/data',
  vars: {
    PUBLIC_WEB_HOST: 'apple-docs.example',
    LABEL_PROXY: 'mt.test.proxy', LABEL_WEB: 'mt.test.web', LABEL_MCP: 'mt.test.mcp',
    LABEL_WATCHDOG: 'mt.test.watchdog',
    LABEL_TUNNEL_WEB: 'mt.test.cf.web', LABEL_TUNNEL_MCP: 'mt.test.cf.mcp',
  },
  labels: {
    web: 'mt.test.web', mcp: 'mt.test.mcp', watchdog: 'mt.test.watchdog',
    proxy: 'mt.test.proxy', tunnelWeb: 'mt.test.cf.web', tunnelMcp: 'mt.test.cf.mcp',
  },
}

function inMemoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    exists: (p) => files.has(p),
    readFile: (p) => files.get(p) ?? '',
    mkdirp: () => {},
  }
}

// A fake subprocess runner. `routes` is shared by reference between
// the `runCmd` and `runCmdAllowFailure` fakes so a single description
// of "what command returns what" covers both. Each route either
// matches by substring against the joined argv or via a predicate.
function fakeRunner(routes = []) {
  const calls = []
  const fn = async (args, opts) => {
    const idx = calls.length
    calls.push({ args, opts, idx })
    for (const route of routes) {
      const matched = typeof route.match === 'function'
        ? route.match(args)
        : args.join(' ').includes(route.match)
      if (matched) {
        if (route.throws) throw route.throws
        const stdout = typeof route.stdout === 'function' ? route.stdout(idx) : (route.stdout ?? '')
        const exitCode = typeof route.exitCode === 'function' ? route.exitCode(idx) : (route.exitCode ?? 0)
        return { args, exitCode, stdout, stderr: '', elapsedMs: 0 }
      }
    }
    return { args, exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }
  }
  return { calls, fn }
}

const releasePayload = (tag) => ({
  tag_name: tag,
  published_at: '2026-05-13T00:00:00Z',
  assets: [
    { name: `apple-docs-full-${tag}.tar.gz`, size: 100, browser_download_url: 'https://x' },
    { name: `apple-docs-full-${tag}.tar.gz.sha256`, size: 1, browser_download_url: 'https://x.sha' },
  ],
})

function makeFetcher(payload) {
  return () => Promise.resolve({
    ok: true, status: 200, headers: { get: () => null },
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  })
}

// Build a ctx with sensible defaults plus per-test overrides. By
// default KEEP_SERVING_DURING_REFRESH=1 and USE_SNAPSHOT=0 so most
// tests exercise the crawl-on-host path without GH-release coupling.
function defaults(overrides = {}) {
  return {
    args: overrides.args ?? [],
    env: overrides.env ?? { KEEP_SERVING_DURING_REFRESH: '1', USE_SNAPSHOT: '0' },
    envLoader: () => ENV,
    logger: overrides.logger ?? captureLogger(),
    deps: {
      fs: inMemoryFs({ '/fake/repo': '', '/fake/ops/caddy/Caddyfile': 'old-caddy' }),
      fetcher: makeFetcher(releasePayload('snapshot-20260513')),
      sleep: async () => {},
      renderAll: async () => 0,
      proxy: async () => 0,
      cfPurge: async () => 0,
      smokeTest: async () => 0,
      pullSnapshot: async () => 0,
      runCmd: fakeRunner().fn,
      runCmdAllowFailure: fakeRunner().fn,
      ...(overrides.deps ?? {}),
    },
  }
}

describe('runDeployUpdate', () => {
  test('exits 1 when repo directory is missing', async () => {
    const log = captureLogger()
    const ctx = defaults({ logger: log })
    ctx.deps.fs = inMemoryFs({}) // no /fake/repo
    const code = await runDeployUpdate(ctx)
    expect(code).toBe(1)
    expect(log.lines.some(m => m.startsWith('E:'))).toBe(true)
  })

  test('exits 2 when dirty tree diverges from origin', async () => {
    const routes = [
      // isDirty: diff --quiet → non-zero
      { match: a => a[3] === 'diff' && a[4] === '--quiet' && !a.includes('--cached'), exitCode: 1 },
      // diff origin/main → non-empty stdout means divergence
      { match: a => a[3] === 'diff' && a[4] === 'origin/main', stdout: 'index 1234..5678' },
    ]
    const runner = fakeRunner(routes)
    const runAllow = fakeRunner(routes)
    const log = captureLogger()
    const code = await runDeployUpdate(defaults({
      logger: log,
      deps: { runCmd: runner.fn, runCmdAllowFailure: runAllow.fn },
    }))
    expect(code).toBe(2)
    expect(log.lines.some(m => m.startsWith('E:'))).toBe(true)
    // No pull was attempted past the divergence guard.
    expect(runner.calls.find(c => c.args.includes('pull'))).toBeUndefined()
  })

  test('dirty tree matching origin gets reset and continues', async () => {
    const routes = [
      { match: a => a[3] === 'diff' && a[4] === '--quiet' && !a.includes('--cached'), exitCode: 1 },
      { match: a => a[3] === 'diff' && a[4] === 'origin/main', stdout: '' }, // matches origin
    ]
    const runner = fakeRunner(routes)
    const runAllow = fakeRunner(routes)
    const code = await runDeployUpdate(defaults({
      deps: { runCmd: runner.fn, runCmdAllowFailure: runAllow.fn },
    }))
    expect(code).toBe(0)
    // git reset --hard HEAD was run, and clean -fd was scoped.
    expect(runner.calls.some(c => c.args.includes('reset') && c.args.includes('--hard'))).toBe(true)
    const clean = runner.calls.find(c => c.args.includes('clean'))
    expect(clean).toBeDefined()
    expect(clean.args.slice(-3)).toEqual(['src', 'test', 'cli.js'])
  })

  test('happy path returns 0 and kickstarts web → mcp → watchdog in order', async () => {
    const sleeps = []
    // All defaults: print returns 0 (loaded → kickstart path), no drift.
    const runner = fakeRunner()
    const runAllow = fakeRunner()
    const code = await runDeployUpdate(defaults({
      deps: {
        runCmd: runner.fn,
        runCmdAllowFailure: runAllow.fn,
        sleep: async (ms) => { sleeps.push(ms) },
      },
    }))
    expect(code).toBe(0)
    const kickLabels = runner.calls
      .filter(c => c.args.includes('kickstart'))
      .map(c => c.args.find(a => a.startsWith('system/')))
    expect(kickLabels).toEqual([
      'system/mt.test.web', 'system/mt.test.mcp', 'system/mt.test.watchdog',
    ])
    // Pre-watchdog and pre-smoke each sleep 3s.
    expect(sleeps.filter(ms => ms === 3000).length).toBeGreaterThanOrEqual(2)
  })

  test('happy path bootstraps cleanly when label is not yet loaded', async () => {
    const routes = [
      // isLoaded: print returns non-zero → cutoverOne takes the bootstrap path
      { match: a => a.includes('print'), exitCode: 113 },
    ]
    const runner = fakeRunner(routes)
    const runAllow = fakeRunner(routes)
    const code = await runDeployUpdate(defaults({
      deps: { runCmd: runner.fn, runCmdAllowFailure: runAllow.fn },
    }))
    expect(code).toBe(0)
    const bootstraps = runAllow.calls.filter(c => c.args.includes('bootstrap'))
    expect(bootstraps.length).toBeGreaterThanOrEqual(3)
  })

  test('skips bun install when package.json and bun.lock are unchanged', async () => {
    const runner = fakeRunner()
    const runAllow = fakeRunner()
    await runDeployUpdate(defaults({
      deps: { runCmd: runner.fn, runCmdAllowFailure: runAllow.fn },
    }))
    const installCalls = runner.calls.filter(c => c.args[0] === ENV.bunBin && c.args[1] === 'install')
    expect(installCalls.length).toBe(0)
  })

  test('runs bun install when bun.lock hash differs after pull', async () => {
    let lockCalls = 0
    const routes = [
      { match: a => a.join(' ').includes('rev-parse HEAD:bun.lock'), stdout: () => `lock-${lockCalls++}` },
    ]
    const runner = fakeRunner(routes)
    const runAllow = fakeRunner(routes)
    await runDeployUpdate(defaults({
      deps: { runCmd: runner.fn, runCmdAllowFailure: runAllow.fn },
    }))
    const installCall = runner.calls.find(c => c.args[0] === ENV.bunBin && c.args[1] === 'install')
    expect(installCall).toBeDefined()
    expect(installCall.args).toContain('--frozen-lockfile')
  })

  test('reloads caddy when Caddyfile hash changes after render', async () => {
    const fs = inMemoryFs({
      '/fake/repo': '',
      '/fake/ops/caddy/Caddyfile': 'pre-render',
    })
    const proxyCalls = []
    const code = await runDeployUpdate(defaults({
      deps: {
        fs,
        renderAll: async () => {
          fs.files.set('/fake/ops/caddy/Caddyfile', 'post-render')
          return 0
        },
        proxy: async (ctx) => { proxyCalls.push(ctx.args); return 0 },
      },
    }))
    expect(code).toBe(0)
    expect(proxyCalls).toContainEqual(['reload'])
  })

  test('skips caddy reload when Caddyfile is unchanged after render', async () => {
    const proxyCalls = []
    await runDeployUpdate(defaults({
      deps: {
        renderAll: async () => 0, // does not touch the Caddyfile
        proxy: async (ctx) => { proxyCalls.push(ctx.args); return 0 },
      },
    }))
    expect(proxyCalls).toEqual([])
  })

  test('warns on plist drift but continues', async () => {
    const fs = inMemoryFs({
      '/fake/repo': '',
      '/fake/ops/caddy/Caddyfile': 'c',
      '/fake/ops/launchd/mt.test.web.plist': 'rendered-A',
      '/Library/LaunchDaemons/mt.test.web.plist': 'installed-B',
    })
    const log = captureLogger()
    const code = await runDeployUpdate(defaults({
      logger: log,
      deps: { fs },
    }))
    expect(code).toBe(0)
    expect(log.lines.some(m => m.includes('plist drift'))).toBe(true)
  })

  test('USE_SNAPSHOT=1 forces snapshot mode (pullSnapshot called, sync not called)', async () => {
    let pullSnapshotCalled = false
    let syncCalled = false
    await runDeployUpdate(defaults({
      env: { USE_SNAPSHOT: '1' },
      deps: {
        runCmd: async (args) => {
          if (args.includes('sync') && args[1] === 'run') syncCalled = true
          return { args, exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }
        },
        pullSnapshot: async () => { pullSnapshotCalled = true; return 0 },
      },
    }))
    expect(pullSnapshotCalled).toBe(true)
    expect(syncCalled).toBe(false)
  })

  test('USE_SNAPSHOT=0 forces crawl-on-host (cli.js sync runs, pullSnapshot skipped)', async () => {
    let pullSnapshotCalled = false
    let syncCalled = false
    await runDeployUpdate(defaults({
      env: { USE_SNAPSHOT: '0' },
      deps: {
        runCmd: async (args) => {
          if (args.includes('sync') && args[1] === 'run') syncCalled = true
          return { args, exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }
        },
        pullSnapshot: async () => { pullSnapshotCalled = true; return 0 },
      },
    }))
    expect(pullSnapshotCalled).toBe(false)
    expect(syncCalled).toBe(true)
  })

  test('USE_SNAPSHOT=auto picks snapshot when GH tag is newer than applied', async () => {
    let pullSnapshotCalled = false
    await runDeployUpdate(defaults({
      env: {}, // not '1' or '0' → auto-detect
      deps: {
        fs: inMemoryFs({ '/fake/repo': '', '/fake/ops/caddy/Caddyfile': 'c' }), // no applied-snapshot
        fetcher: makeFetcher(releasePayload('snapshot-20260513')),
        pullSnapshot: async () => { pullSnapshotCalled = true; return 0 },
      },
    }))
    expect(pullSnapshotCalled).toBe(true)
  })

  test('USE_SNAPSHOT=auto picks crawl when applied tag matches the latest GH tag', async () => {
    let pullSnapshotCalled = false
    let syncCalled = false
    await runDeployUpdate(defaults({
      env: {},
      deps: {
        fs: inMemoryFs({
          '/fake/repo': '',
          '/fake/ops/caddy/Caddyfile': 'c',
          '/fake/ops/state/applied-snapshot': 'snapshot-20260513\n',
        }),
        fetcher: makeFetcher(releasePayload('snapshot-20260513')),
        pullSnapshot: async () => { pullSnapshotCalled = true; return 0 },
        runCmd: async (args) => {
          if (args.includes('sync') && args[1] === 'run') syncCalled = true
          return { args, exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }
        },
      },
    }))
    expect(pullSnapshotCalled).toBe(false)
    expect(syncCalled).toBe(true)
  })

  test('USE_SNAPSHOT=auto falls back to crawl when GH releases endpoint errors out', async () => {
    let syncCalled = false
    const log = captureLogger()
    await runDeployUpdate(defaults({
      logger: log,
      env: {},
      deps: {
        fetcher: () => Promise.resolve({
          ok: false, status: 503, statusText: 'oops',
          headers: { get: () => null },
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(''),
        }),
        runCmd: async (args) => {
          if (args.includes('sync') && args[1] === 'run') syncCalled = true
          return { args, exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }
        },
      },
    }))
    expect(syncCalled).toBe(true)
    expect(log.lines.some(m => m.startsWith('W:') && m.includes('GH'))).toBe(true)
  })

  test('pullSnapshot failure falls back to cli.js sync', async () => {
    let syncCalled = false
    await runDeployUpdate(defaults({
      env: { USE_SNAPSHOT: '1' },
      deps: {
        pullSnapshot: async () => 2,
        runCmd: async (args) => {
          if (args.includes('sync') && args[1] === 'run') syncCalled = true
          return { args, exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }
        },
      },
    }))
    expect(syncCalled).toBe(true)
  })

  test('--full uses --full build flag instead of --incremental', async () => {
    const calls = []
    await runDeployUpdate(defaults({
      args: ['--full'],
      deps: {
        runCmd: async (args) => {
          calls.push(args)
          return { args, exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }
        },
      },
    }))
    const buildCall = calls.find(a => a.includes('build') && a[3] === 'web')
    expect(buildCall).toBeDefined()
    expect(buildCall).toContain('--full')
    expect(buildCall).not.toContain('--incremental')
  })

  test('default rebuild uses --incremental', async () => {
    const calls = []
    await runDeployUpdate(defaults({
      deps: {
        runCmd: async (args) => {
          calls.push(args)
          return { args, exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }
        },
      },
    }))
    const buildCall = calls.find(a => a.includes('build') && a[3] === 'web')
    expect(buildCall).toBeDefined()
    expect(buildCall).toContain('--incremental')
    expect(buildCall).not.toContain('--full')
  })

  test('--full build failure returns exit 4', async () => {
    const code = await runDeployUpdate(defaults({
      args: ['--full'],
      deps: {
        runCmd: async (args) => {
          if (args.includes('build') && args[3] === 'web') {
            throw Object.assign(new Error('static build failed'), { exitCode: 1 })
          }
          return { args, exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }
        },
      },
    }))
    expect(code).toBe(4)
  })

  test('incremental build failure is non-fatal and logs a warning', async () => {
    const log = captureLogger()
    const code = await runDeployUpdate(defaults({
      logger: log,
      deps: {
        runCmd: async (args) => {
          if (args.includes('build') && args[3] === 'web') {
            throw Object.assign(new Error('incremental blew up'), { exitCode: 1 })
          }
          return { args, exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }
        },
      },
    }))
    expect(code).toBe(0)
    expect(log.lines.some(m => m.startsWith('W:') && m.includes('incremental'))).toBe(true)
  })

  test('KEEP_SERVING_DURING_REFRESH=0 stops web + mcp before the refresh', async () => {
    const runner = fakeRunner()
    const runAllow = fakeRunner()
    await runDeployUpdate(defaults({
      env: { KEEP_SERVING_DURING_REFRESH: '0' },
      deps: { runCmd: runner.fn, runCmdAllowFailure: runAllow.fn },
    }))
    const bootouts = runAllow.calls
      .filter(c => c.args.includes('bootout'))
      .map(c => c.args.find(a => a.startsWith('system/')))
    // Early stops happen before any cutover work — these are the
    // pre-refresh bootouts when KEEP_SERVING is disabled.
    expect(bootouts).toEqual(expect.arrayContaining(['system/mt.test.web', 'system/mt.test.mcp']))
  })

  test('git pull failure returns exit 3', async () => {
    const routes = [
      { match: a => a[3] === 'pull', throws: Object.assign(new Error('ff blocked'), { exitCode: 128 }) },
    ]
    const runner = fakeRunner(routes)
    const runAllow = fakeRunner(routes)
    const code = await runDeployUpdate(defaults({
      deps: { runCmd: runner.fn, runCmdAllowFailure: runAllow.fn },
    }))
    expect(code).toBe(3)
  })

  test('cf-purge and smoke-test are invoked at the tail of the flow', async () => {
    const cfCalls = []
    const smokeCalls = []
    await runDeployUpdate(defaults({
      deps: {
        cfPurge: async (ctx) => { cfCalls.push(ctx); return 0 },
        smokeTest: async (ctx) => { smokeCalls.push(ctx); return 0 },
      },
    }))
    expect(cfCalls.length).toBe(1)
    expect(smokeCalls.length).toBe(1)
  })
})

import { describe, test, expect } from 'bun:test'
import runPullSnapshot from '../../../ops/cmd/pull-snapshot.js'

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
    PUBLIC_WEB_HOST: 'apple-docs.example',
    WEB_PORT: '3130', MCP_PORT: '3131',
    PUBLIC_MCP_HOST: 'apple-docs-mcp.example',
    LABEL_WEB: 'mt.test.web', LABEL_MCP: 'mt.test.mcp',
    LABEL_WATCHDOG: 'mt.test.watchdog',
  },
  labels: {
    web: 'mt.test.web', mcp: 'mt.test.mcp', watchdog: 'mt.test.watchdog',
    proxy: 'mt.test.proxy', tunnelWeb: 'mt.test.cloudflared.web', tunnelMcp: 'mt.test.cloudflared.mcp',
  },
}

function inMemoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    exists: (p) => files.has(p),
    readFile: (p) => files.get(p) ?? '',
    writeFile: (p, c) => { files.set(p, c) },
    mkdirp: () => {},
  }
}

function fakeRunner(scriptedErrors = {}) {
  const calls = []
  const fn = async (args, opts) => {
    calls.push({ args, opts })
    const key = args.slice(0, 3).join(' ')
    if (scriptedErrors[key]) throw scriptedErrors[key]
    return { args, exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }
  }
  return { calls, fn }
}

function makeFetcher(release) {
  return () => Promise.resolve({
    ok: true, status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(release),
    text: () => Promise.resolve(JSON.stringify(release)),
  })
}

const releasePayload = (tag) => ({
  tag_name: tag,
  published_at: '2026-05-13T00:00:00Z',
  assets: [
    { name: `apple-docs-full-${tag}.tar.gz`, size: 100, browser_download_url: 'https://x' },
    { name: `apple-docs-full-${tag}.tar.gz.sha256`, size: 1, browser_download_url: 'https://x.sha' },
  ],
})

describe('runPullSnapshot', () => {
  test('no-op when applied tag matches and --force not set', async () => {
    const log = captureLogger()
    const code = await runPullSnapshot({
      args: [], envLoader: () => ENV, logger: log,
      deps: {
        fetcher: makeFetcher(releasePayload('snapshot-20260513')),
        fs: inMemoryFs({ '/fake/ops/state/applied-snapshot': 'snapshot-20260513\n' }),
        runCmd: fakeRunner().fn,
        runCmdAllowFailure: fakeRunner().fn,
        bootout: async () => {}, bootstrapOrKick: async () => ({}),
        smokeTest: async () => 0, cfPurge: async () => 0, sleep: async () => {},
      },
    })
    expect(code).toBe(0)
    expect(log.lines.some(m => m.includes('nothing to do'))).toBe(true)
  })

  test('--force triggers the install even when tag matches', async () => {
    const stops = []
    const code = await runPullSnapshot({
      args: ['--force'], envLoader: () => ENV, logger: captureLogger(),
      deps: {
        fetcher: makeFetcher(releasePayload('snapshot-20260513')),
        fs: inMemoryFs({ '/fake/ops/state/applied-snapshot': 'snapshot-20260513\n' }),
        runCmd: fakeRunner().fn, runCmdAllowFailure: fakeRunner().fn,
        bootout: async (label) => { stops.push(label) },
        bootstrapOrKick: async () => ({}),
        smokeTest: async () => 0, cfPurge: async () => 0, sleep: async () => {},
      },
    })
    expect(code).toBe(0)
    expect(stops).toEqual(['mt.test.watchdog', 'mt.test.web', 'mt.test.mcp'])
  })

  test('applies a newer release and stamps applied-snapshot', async () => {
    const fs = inMemoryFs({ '/fake/ops/state/applied-snapshot': 'snapshot-20260511\n' })
    const runner = fakeRunner()
    const order = []
    const code = await runPullSnapshot({
      args: [], envLoader: () => ENV, logger: captureLogger(),
      deps: {
        fetcher: makeFetcher(releasePayload('snapshot-20260513')),
        fs,
        runCmd: runner.fn,
        runCmdAllowFailure: async () => ({ exitCode: 0 }),
        bootout: async (label) => { order.push({ op: 'stop', label }) },
        bootstrapOrKick: async (label) => { order.push({ op: 'start', label }) },
        smokeTest: async () => 0,
        cfPurge: async () => 0,
        sleep: async () => {},
      },
    })
    expect(code).toBe(0)
    // Setup command was invoked.
    const setup = runner.calls.find(c => c.args.includes('setup'))
    expect(setup).toBeDefined()
    expect(setup.args).toContain('--force')
    // Web build was invoked.
    const build = runner.calls.find(c => c.args.includes('build'))
    expect(build).toBeDefined()
    expect(build.args).toContain('--incremental')

    // Services restarted in deterministic order, web+mcp first.
    const starts = order.filter(o => o.op === 'start').map(o => o.label)
    expect(starts.slice(0, 2)).toEqual(['mt.test.web', 'mt.test.mcp'])
    expect(starts.at(-1)).toBe('mt.test.watchdog')

    // applied-snapshot updated.
    expect(fs.files.get('/fake/ops/state/applied-snapshot')).toBe('snapshot-20260513\n')
  })

  test('returns 2 + restores services when setup throws', async () => {
    const fs = inMemoryFs({})
    const order = []
    // The fakeRunner keys errors by args.slice(0, 3).join(' '), so the
    // first 3 args of the failing call need to match exactly.
    const runner = fakeRunner({
      [`/usr/local/bin/bun run /fake/repo/cli.js`]: Object.assign(new Error('setup blew up'), { exitCode: 7 }),
    })
    const code = await runPullSnapshot({
      args: [], envLoader: () => ENV, logger: captureLogger(),
      deps: {
        fetcher: makeFetcher(releasePayload('snapshot-20260513')),
        fs,
        runCmd: runner.fn,
        runCmdAllowFailure: async () => ({ exitCode: 0 }),
        bootout: async (label) => { order.push({ op: 'stop', label }) },
        bootstrapOrKick: async (label) => { order.push({ op: 'start', label }) },
        smokeTest: async () => 0, cfPurge: async () => 0, sleep: async () => {},
      },
    })
    expect(code).toBe(2)
    // Daemons were restored even though setup failed.
    expect(order.filter(o => o.op === 'start').length).toBeGreaterThan(0)
  })

  test('returns 1 when GH releases endpoint is unreachable', async () => {
    const log = captureLogger()
    const fetcher = () => Promise.resolve({
      ok: false, status: 503, statusText: 'Service Unavailable',
      headers: { get: () => null },
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    })
    const code = await runPullSnapshot({
      args: [], envLoader: () => ENV, logger: log,
      deps: { fetcher, fs: inMemoryFs(), runCmd: fakeRunner().fn, runCmdAllowFailure: fakeRunner().fn,
              bootout: async () => {}, bootstrapOrKick: async () => ({}),
              smokeTest: async () => 0, cfPurge: async () => 0, sleep: async () => {} },
    })
    expect(code).toBe(1)
    expect(log.lines.some(m => m.startsWith('E:'))).toBe(true)
  })
})

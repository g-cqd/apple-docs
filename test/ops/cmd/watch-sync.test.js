import { describe, test, expect } from 'bun:test'
import runWatchSync from '../../../ops/cmd/watch-sync.js'

const ENV = {
  opsDir: '/fake/ops',
  vars: { WEB_PORT: '3130', MCP_PORT: '3131' },
  labels: {
    web: 'mt.test.web',
    mcp: 'mt.test.mcp',
    watchdog: 'mt.test.watchdog',
    proxy: 'mt.test.proxy',
    tunnelWeb: 'mt.test.cloudflared.web',
    tunnelMcp: 'mt.test.cloudflared.mcp',
  },
}

function captureLogger() {
  const lines = []
  return { lines, say: m => lines.push(m), warn: m => lines.push('W:' + m), error: m => lines.push('E:' + m) }
}

function makeResp(status) {
  return {
    ok: status === 200, status,
    headers: { get: () => null },
    body: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array([])); c.close() } }),
    text: () => Promise.resolve(''),
  }
}

describe('runWatchSync', () => {
  test('returns 64 when SYNC_PID is missing', async () => {
    const log = captureLogger()
    const code = await runWatchSync({ env: {}, envLoader: () => ENV, logger: log })
    expect(code).toBe(64)
    expect(log.lines.some(m => m.startsWith('E:watch-sync'))).toBe(true)
  })

  test('returns 64 when SYNC_PID is non-numeric', async () => {
    const code = await runWatchSync({ env: { SYNC_PID: 'nope' }, envLoader: () => ENV, logger: captureLogger() })
    expect(code).toBe(64)
  })

  test('polls until sync exits, then bootstraps + kickstarts both daemons', async () => {
    const kickstarted = []
    const bootstrapped = []
    let killCalls = 0
    const deps = {
      kill: () => { killCalls++; return killCalls <= 2 },                       // alive for 2 polls then dead
      sleep: async () => {},
      bootstrap: async (label, plist) => { bootstrapped.push({ label, plist }) },
      kickstart: async (label) => { kickstarted.push(label) },
      fetcher: () => Promise.resolve(makeResp(200)),                            // /healthz reports 200 immediately
      smokeTest: async () => 0,
    }
    const log = captureLogger()
    const code = await runWatchSync({
      env: { SYNC_PID: '42' }, envLoader: () => ENV, logger: log, deps,
    })
    expect(code).toBe(0)
    expect(killCalls).toBeGreaterThanOrEqual(3)
    expect(bootstrapped).toEqual([
      { label: 'mt.test.web', plist: '/Library/LaunchDaemons/mt.test.web.plist' },
    ])
    expect(kickstarted).toEqual(['mt.test.web', 'mt.test.mcp'])
    expect(log.lines.some(m => m.includes('local web responding 200'))).toBe(true)
  })

  test('returns 1 if kickstart of web daemon throws', async () => {
    const deps = {
      kill: () => false,                              // sync already dead
      sleep: async () => {},
      bootstrap: async () => {},
      kickstart: async (label) => {
        if (label === 'mt.test.web') throw new Error('sudoers missing')
      },
      fetcher: () => Promise.resolve(makeResp(200)),
      smokeTest: async () => 0,
    }
    const log = captureLogger()
    const code = await runWatchSync({
      env: { SYNC_PID: '7' }, envLoader: () => ENV, logger: log, deps,
    })
    expect(code).toBe(1)
    expect(log.lines.some(m => m.includes('could not kickstart web daemon'))).toBe(true)
  })

  test('warns but still exits 0 when MCP kickstart fails', async () => {
    const deps = {
      kill: () => false, sleep: async () => {}, bootstrap: async () => {},
      kickstart: async (label) => {
        if (label === 'mt.test.mcp') throw new Error('mcp-failed')
      },
      fetcher: () => Promise.resolve(makeResp(200)),
      smokeTest: async () => 0,
    }
    const log = captureLogger()
    const code = await runWatchSync({
      env: { SYNC_PID: '7' }, envLoader: () => ENV, logger: log, deps,
    })
    expect(code).toBe(0)
    expect(log.lines.some(m => m.startsWith('W:') && m.includes('mcp'))).toBe(true)
  })

  test('continues even when smoke-test rejects', async () => {
    const deps = {
      kill: () => false, sleep: async () => {}, bootstrap: async () => {},
      kickstart: async () => {},
      fetcher: () => Promise.resolve(makeResp(200)),
      smokeTest: async () => { throw new Error('smoke crashed') },
    }
    const log = captureLogger()
    const code = await runWatchSync({
      env: { SYNC_PID: '7' }, envLoader: () => ENV, logger: log, deps,
    })
    expect(code).toBe(0)
    expect(log.lines.at(-1)).toBe('watcher done')
  })
})

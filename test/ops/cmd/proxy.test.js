import { describe, test, expect } from 'bun:test'
import runProxy from '../../../ops/cmd/proxy.js'

const ENV = {
  opsDir: '/fake/ops',
  vars: { CADDY_ADMIN_ADDR: '127.0.0.1:2019' },
}

function captureLogger() {
  const lines = []
  return { lines, say: m => lines.push(m), warn: m => lines.push('W:' + m), error: m => lines.push('E:' + m) }
}

function captureRunner(exitCode = 0, stdout = '', stderr = '') {
  const calls = []
  return {
    calls,
    fn: async (args, opts) => {
      calls.push({ args, opts })
      return { args, exitCode, stdout, stderr, elapsedMs: 0 }
    },
  }
}

function jsonResp({ status = 200, body = '[]' } = {}) {
  const bytes = new TextEncoder().encode(body)
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    body: new ReadableStream({ pull(c) { c.enqueue(bytes); c.close() } }),
    text: () => Promise.resolve(body),
  }
}

const presentDeps = (runner = captureRunner()) => ({
  exists: () => true,
  which: () => '/opt/homebrew/bin/caddy',
  runCmd: runner.fn,
})

describe('runProxy', () => {
  test('returns 64 on unknown verb', async () => {
    const code = await runProxy({ args: ['frobnicate'], envLoader: () => ENV, logger: captureLogger() })
    expect(code).toBe(64)
  })

  test('returns 66 when Caddyfile is missing', async () => {
    const deps = { exists: () => false, which: () => '/opt/homebrew/bin/caddy', runCmd: async () => ({ exitCode: 0 }) }
    const log = captureLogger()
    const code = await runProxy({ args: ['validate'], envLoader: () => ENV, logger: log, deps })
    expect(code).toBe(66)
    expect(log.lines.some(m => m.includes('not found'))).toBe(true)
  })

  test('returns 127 when caddy binary is not on PATH', async () => {
    const deps = { exists: () => true, which: () => null, runCmd: async () => ({ exitCode: 0 }) }
    const code = await runProxy({ args: ['validate'], envLoader: () => ENV, logger: captureLogger(), deps })
    expect(code).toBe(127)
  })

  test('validate invokes caddy validate with the Caddyfile path', async () => {
    const r = captureRunner(0)
    const code = await runProxy({ args: ['validate'], envLoader: () => ENV, logger: captureLogger(), deps: presentDeps(r) })
    expect(code).toBe(0)
    expect(r.calls[0].args).toEqual([
      '/opt/homebrew/bin/caddy', 'validate', '--config', '/fake/ops/caddy/Caddyfile', '--adapter', 'caddyfile',
    ])
  })

  test('reload runs validate first, then reload, both via the caddy bin', async () => {
    const r = captureRunner(0)
    const code = await runProxy({ args: ['reload'], envLoader: () => ENV, logger: captureLogger(), deps: presentDeps(r) })
    expect(code).toBe(0)
    expect(r.calls.length).toBe(2)
    expect(r.calls[0].args[1]).toBe('validate')
    expect(r.calls[1].args[1]).toBe('reload')
    expect(r.calls[1].args).toContain('--address')
    expect(r.calls[1].args).toContain('127.0.0.1:2019')
  })

  test('reload aborts when validate fails', async () => {
    const r = captureRunner(1, '', 'caddyfile syntax error')
    const code = await runProxy({ args: ['reload'], envLoader: () => ENV, logger: captureLogger(), deps: presentDeps(r) })
    expect(code).toBe(1)
    expect(r.calls.length).toBe(1)
    expect(r.calls[0].args[1]).toBe('validate')
  })

  test('status hits the admin upstream endpoint', async () => {
    let captured
    const fetcher = (url) => {
      captured = url
      return Promise.resolve(jsonResp({ body: '[{"address":"127.0.0.1:3130"}]' }))
    }
    const log = captureLogger()
    const code = await runProxy({
      args: ['status'], envLoader: () => ENV, logger: log,
      deps: { exists: () => true, which: () => '/x', runCmd: async () => ({ exitCode: 0 }), fetcher },
    })
    expect(code).toBe(0)
    expect(captured).toBe('http://127.0.0.1:2019/reverse_proxy/upstreams')
    expect(log.lines.some(m => m.includes('127.0.0.1:3130'))).toBe(true)
  })

  test('status returns 1 when the admin API is unreachable', async () => {
    const fetcher = () => Promise.reject(new Error('ECONNREFUSED'))
    const log = captureLogger()
    const code = await runProxy({
      args: ['status'], envLoader: () => ENV, logger: log,
      deps: { exists: () => true, which: () => '/x', runCmd: async () => ({ exitCode: 0 }), fetcher },
    })
    expect(code).toBe(1)
    expect(log.lines.some(m => m.startsWith('E:proxy: could not query'))).toBe(true)
  })

  test('run supervises caddy via spawn (NOT runCmd) and propagates exit code', async () => {
    // runCmd has a 60s default deadline that would SIGKILL caddy mid-
    // serve. `proxy run` must spawn caddy directly and wait on its
    // exit without any timeout.
    let spawnCalledWith
    const spawn = (args, opts) => {
      spawnCalledWith = { args, opts }
      return {
        exited: Promise.resolve(0),
        kill: () => {},
      }
    }
    const r = captureRunner()
    const code = await runProxy({
      args: ['run'], envLoader: () => ENV, logger: captureLogger(),
      deps: { ...presentDeps(r), spawn },
    })
    expect(code).toBe(0)
    // runCmd was NOT used for the long-running spawn.
    expect(r.calls.length).toBe(0)
    expect(spawnCalledWith.args[0]).toBe('/opt/homebrew/bin/caddy')
    expect(spawnCalledWith.args[1]).toBe('run')
    expect(spawnCalledWith.opts.stdout).toBe('inherit')
    expect(spawnCalledWith.opts.stderr).toBe('inherit')
  })

  test('run returns a non-zero exit if caddy exits non-zero', async () => {
    const spawn = () => ({ exited: Promise.resolve(2), kill: () => {} })
    const code = await runProxy({
      args: ['run'], envLoader: () => ENV, logger: captureLogger(),
      deps: { ...presentDeps(), spawn },
    })
    expect(code).toBe(2)
  })
})

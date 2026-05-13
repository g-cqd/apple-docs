import { describe, test, expect } from 'bun:test'
import { dispatch, printUsage } from '../../ops/cli.js'

function captureStream() {
  const chunks = []
  return { chunks, write(s) { chunks.push(s) } }
}

function fakeLoader(impl, { exportShape = 'default' } = {}) {
  return async (_name) => {
    if (exportShape === 'no-default') return {}
    return { default: impl }
  }
}

describe('dispatch', () => {
  test('routes to the subcommand and returns its exit code', async () => {
    let called
    const loader = fakeLoader(async ({ args }) => {
      called = args
      return 42
    })
    const code = await dispatch(['smoke', '--foo', 'bar'], { loadCommand: loader, stderr: captureStream(), stdout: captureStream() })
    expect(called).toEqual(['--foo', 'bar'])
    expect(code).toBe(42)
  })

  test('returns 0 when command returns nothing (success default)', async () => {
    const loader = fakeLoader(async () => {})
    const code = await dispatch(['smoke'], { loadCommand: loader, stderr: captureStream(), stdout: captureStream() })
    expect(code).toBe(0)
  })

  test('prints usage and returns 0 on --help', async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const code = await dispatch(['--help'], { stdout, stderr })
    expect(code).toBe(0)
    const text = stdout.chunks.join('')
    expect(text).toContain('Usage: ops/cli.js')
    expect(text).toContain('smoke')
    expect(text).toContain('deploy')
  })

  test('treats empty argv as help', async () => {
    const stdout = captureStream()
    const code = await dispatch([], { stdout, stderr: captureStream() })
    expect(code).toBe(0)
    expect(stdout.chunks.join('')).toContain('Usage')
  })

  test('exits 64 on unknown command', async () => {
    const stderr = captureStream()
    const code = await dispatch(['nope'], { stderr, stdout: captureStream() })
    expect(code).toBe(64)
    expect(stderr.chunks.join('')).toContain('unknown command "nope"')
  })

  test('exits 70 when command module has no default export', async () => {
    const loader = fakeLoader(null, { exportShape: 'no-default' })
    const stderr = captureStream()
    const code = await dispatch(['smoke'], { loadCommand: loader, stderr, stdout: captureStream() })
    expect(code).toBe(70)
    expect(stderr.chunks.join('')).toContain('did not export a default function')
  })

  test('propagates command exitCode on thrown error', async () => {
    const loader = fakeLoader(async () => {
      const err = new Error('configuration drift')
      err.exitCode = 78
      throw err
    })
    const stderr = captureStream()
    const code = await dispatch(['deploy'], { loadCommand: loader, stderr, stdout: captureStream() })
    expect(code).toBe(78)
    expect(stderr.chunks.join('')).toContain('configuration drift')
  })

  test('exits 1 on thrown error without exitCode', async () => {
    const loader = fakeLoader(async () => { throw new Error('boom') })
    const stderr = captureStream()
    const code = await dispatch(['deploy'], { loadCommand: loader, stderr, stdout: captureStream() })
    expect(code).toBe(1)
  })

  test('--version emits a version line', async () => {
    const stdout = captureStream()
    const code = await dispatch(['--version'], { stdout, stderr: captureStream() })
    expect(code).toBe(0)
    expect(stdout.chunks.join('')).toContain('apple-docs ops 2.0')
  })
})

describe('printUsage', () => {
  test('lists every registered command', () => {
    const stream = captureStream()
    printUsage(stream)
    const text = stream.chunks.join('')
    for (const cmd of ['install', 'render-all', 'deploy', 'pull-snapshot', 'smoke', 'cf-purge', 'watchdog', 'watch-sync', 'proxy', 'service']) {
      expect(text).toContain(cmd)
    }
  })
})

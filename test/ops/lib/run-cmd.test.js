/**
 * Tests for ops/lib/run-cmd.js. Uses a fake `spawn` so we don't shell
 * out per assertion — that keeps the suite ~ms instead of ~seconds and
 * makes timing-sensitive tests (deadlines) reproducible.
 */

import { describe, test, expect } from 'bun:test'
import { runCmd, runCmdAllowFailure, RunCmdError } from '../../../ops/lib/run-cmd.js'

function fakeSpawn({ exitCode = 0, stdout = '', stderr = '', delayMs = 0, killOnSignal = true } = {}) {
  return (args, opts) => {
    const calls = { args, opts }
    let kill = () => {}
    const stdoutStream = stream(stdout)
    const stderrStream = stream(stderr)
    const exited = delayMs > 0
      ? new Promise((resolve) => {
          const timer = setTimeout(() => resolve(exitCode), delayMs)
          kill = (_sig) => {
            if (killOnSignal) {
              clearTimeout(timer)
              resolve(137) // SIGKILL maps to 128 + 9 = 137
            }
          }
        })
      : Promise.resolve(exitCode)
    return {
      stdout: stdoutStream,
      stderr: stderrStream,
      stdin: null,
      exited,
      kill: (sig) => kill(sig),
      calls,
    }
  }
}

function stream(text) {
  const bytes = new TextEncoder().encode(text)
  let cursor = 0
  return new ReadableStream({
    pull(controller) {
      if (cursor >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.subarray(cursor))
      cursor = bytes.length
    },
  })
}

describe('runCmd', () => {
  test('returns captured stdout on success', async () => {
    const r = await runCmd(['echo', 'ok'], { deps: { spawn: fakeSpawn({ stdout: 'ok\n' }) } })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('ok\n')
    expect(r.stderr).toBe('')
  })

  test('throws RunCmdError with stderr on non-zero exit', async () => {
    const spawn = fakeSpawn({ exitCode: 2, stderr: 'boom' })
    try {
      await runCmd(['cmd', 'arg'], { deps: { spawn } })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(RunCmdError)
      expect(err.kind).toBe('exit')
      expect(err.exitCode).toBe(2)
      expect(err.stderr).toBe('boom')
      expect(err.args).toEqual(['cmd', 'arg'])
      expect(err.message).toContain('exited 2')
      expect(err.message).toContain('boom')
    }
  })

  test('throws timeout error when deadline is exceeded', async () => {
    const spawn = fakeSpawn({ delayMs: 1000 })
    try {
      await runCmd(['sleep', '1'], { deadlineMs: 10, deps: { spawn } })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(RunCmdError)
      expect(err.kind).toBe('timeout')
      expect(err.deadlineMs).toBe(10)
    }
  })

  test('refuses empty args', async () => {
    await expect(runCmd([])).rejects.toBeInstanceOf(RunCmdError)
  })

  test('forwards cwd and env to spawn', async () => {
    let captured
    const spawn = (args, opts) => {
      captured = opts
      return fakeSpawn({ stdout: '' })(args, opts)
    }
    await runCmd(['true'], { cwd: '/tmp', env: { FOO: 'bar' }, deps: { spawn } })
    expect(captured.cwd).toBe('/tmp')
    expect(captured.env).toEqual({ FOO: 'bar' })
  })

  test('truncates stdout above stdoutMaxBytes', async () => {
    const big = 'x'.repeat(10_000)
    const spawn = fakeSpawn({ stdout: big })
    const r = await runCmd(['noop'], { stdoutMaxBytes: 100, deps: { spawn } })
    expect(r.stdout.length).toBeLessThan(big.length)
    expect(r.stdout).toContain('truncated at 100 bytes')
  })

  test('records elapsedMs via the injected clock', async () => {
    let t = 1_000
    const clock = () => t
    const spawn = (args, opts) => {
      const wrapped = fakeSpawn({ stdout: 'ok' })(args, opts)
      // advance the clock between start and finish so elapsedMs > 0
      const original = wrapped.exited
      wrapped.exited = original.then((c) => { t += 42; return c })
      return wrapped
    }
    const r = await runCmd(['x'], { deps: { spawn, clock } })
    expect(r.elapsedMs).toBe(42)
  })
})

describe('runCmdAllowFailure', () => {
  test('returns the result on non-zero exit instead of throwing', async () => {
    const spawn = fakeSpawn({ exitCode: 113, stderr: 'no such service' })
    const r = await runCmdAllowFailure(['launchctl', 'print', 'foo'], { deps: { spawn } })
    expect(r.exitCode).toBe(113)
    expect(r.stderr).toBe('no such service')
  })

  test('still throws on timeout', async () => {
    const spawn = fakeSpawn({ delayMs: 1000 })
    await expect(
      runCmdAllowFailure(['hang'], { deadlineMs: 10, deps: { spawn } }),
    ).rejects.toBeInstanceOf(RunCmdError)
  })
})

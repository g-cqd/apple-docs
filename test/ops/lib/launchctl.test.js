/**
 * Tests for ops/lib/launchctl.js. Every assertion uses an injected
 * fake `runCmd` so we don't shell out to sudo (which would fail
 * non-interactively anyway).
 */

import { describe, test, expect } from 'bun:test'
import {
  isLoaded,
  bootstrapOrKick,
  bootout,
  kickstart,
  stopOne,
  startOne,
} from '../../../ops/lib/launchctl.js'

function recorder(scriptedExits = []) {
  const calls = []
  let i = 0
  const next = () => {
    const exitCode = scriptedExits[i] ?? 0
    i++
    return exitCode
  }
  const fake = async (args, options) => {
    calls.push({ args, options })
    const exitCode = next()
    return { args, exitCode, stdout: '', stderr: '', elapsedMs: 0 }
  }
  return { calls, fake }
}

describe('isLoaded', () => {
  test('returns true on exit 0', async () => {
    const { fake, calls } = recorder([0])
    const out = await isLoaded('mt.test.web', { runCmd: fake })
    expect(out).toBe(true)
    expect(calls[0].args).toEqual([
      '/usr/bin/sudo', '-n', '/bin/launchctl', 'print', 'system/mt.test.web',
    ])
  })
  test('returns false on non-zero exit', async () => {
    const { fake } = recorder([113])
    expect(await isLoaded('mt.test.web', { runCmd: fake })).toBe(false)
  })
})

describe('bootstrapOrKick', () => {
  test('bootstrap success → returns bootstrapped', async () => {
    const { fake, calls } = recorder([0])
    const r = await bootstrapOrKick('mt.test.web', '/Library/LaunchDaemons/mt.test.web.plist', {
      runCmdAllowFailure: fake,
    })
    expect(r.kind).toBe('bootstrapped')
    expect(calls[0].args.slice(-3)).toEqual([
      'bootstrap', 'system', '/Library/LaunchDaemons/mt.test.web.plist',
    ])
  })

  test('bootstrap fails → kickstart called', async () => {
    const allow = recorder([5]) // bootstrap exits non-zero (EEXIST etc.)
    const success = recorder([0]) // kickstart succeeds
    const r = await bootstrapOrKick('mt.test.web', '/x.plist', {
      runCmdAllowFailure: allow.fake,
      runCmd: success.fake,
    })
    expect(r.kind).toBe('kickstarted')
    expect(success.calls).toHaveLength(1)
    expect(success.calls[0].args.slice(-3)).toEqual(['kickstart', '-k', 'system/mt.test.web'])
  })
})

describe('bootout', () => {
  test('issues bootout with correct args', async () => {
    const { fake, calls } = recorder([0])
    await bootout('mt.test.mcp', { runCmdAllowFailure: fake })
    expect(calls[0].args).toEqual([
      '/usr/bin/sudo', '-n', '/bin/launchctl', 'bootout', 'system/mt.test.mcp',
    ])
  })
  test('does not throw when label was not loaded (non-zero exit)', async () => {
    const { fake } = recorder([5])
    const r = await bootout('mt.test.absent', { runCmdAllowFailure: fake })
    expect(r.exitCode).toBe(5)
  })
})

describe('kickstart', () => {
  test('issues kickstart -k with correct args', async () => {
    const { fake, calls } = recorder([0])
    await kickstart('mt.test.web', { runCmd: fake })
    expect(calls[0].args).toEqual([
      '/usr/bin/sudo', '-n', '/bin/launchctl', 'kickstart', '-k', 'system/mt.test.web',
    ])
  })
})

describe('stopOne', () => {
  test('skips bootout when label is not loaded', async () => {
    const recordedSays = []
    const logger = { say: (m) => recordedSays.push(m) }
    const print = recorder([113]) // isLoaded returns false
    const r = await stopOne('mt.test.web', { logger, runCmd: print.fake, runCmdAllowFailure: print.fake })
    expect(r.kind).toBe('already-stopped')
    expect(recordedSays[0]).toContain('not loaded')
  })

  test('calls bootout when label is loaded', async () => {
    const recordedSays = []
    const logger = { say: (m) => recordedSays.push(m) }
    let nextExit = 0
    const fake = async (args) => {
      const out = { args, exitCode: nextExit, stdout: '', stderr: '', elapsedMs: 0 }
      nextExit = 0
      return out
    }
    const r = await stopOne('mt.test.web', { logger, runCmd: fake, runCmdAllowFailure: fake })
    expect(r.kind).toBe('stopped')
    expect(recordedSays.join(' ')).toContain('stopping mt.test.web')
  })
})

describe('startOne', () => {
  test('refuses to start when plist file is missing', async () => {
    const fake = async () => ({ exitCode: 0 })
    await expect(startOne('mt.test.web', '/missing.plist', {
      fs: { exists: () => false },
      runCmd: fake,
      runCmdAllowFailure: fake,
    })).rejects.toThrow(/missing/)
  })

  test('bootstrap-or-kicks when plist exists', async () => {
    const logger = { say: () => {} }
    const bootstrap = recorder([0]) // bootstrap success
    const r = await startOne('mt.test.web', '/x.plist', {
      logger,
      fs: { exists: () => true },
      runCmd: bootstrap.fake,
      runCmdAllowFailure: bootstrap.fake,
    })
    expect(r.kind).toBe('bootstrapped')
  })
})

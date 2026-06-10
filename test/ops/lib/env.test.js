/**
 * Tests for ops/lib/env.js. Uses injected fs/stat fakes so we don't
 * have to chmod real files — the suite is deterministic and runs on
 * any host regardless of who's logged in.
 */

import { describe, test, expect } from 'bun:test'
import { loadEnv, parseEnvFile, EnvLoadError, REQUIRED_VARS } from '../../../ops/lib/env.js'

function minimalEnv(extra = {}) {
  const base = Object.fromEntries(REQUIRED_VARS.map(k => [k, `${k.toLowerCase()}-value`]))
  return { ...base, ...extra }
}

function envText(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
}

function fakeDeps({ uid = 1000, mode = 0o600, fileText, readError } = {}) {
  return {
    readFile: () => {
      if (readError) throw readError
      return fileText ?? ''
    },
    stat: () => ({ mode, uid }),
    currentUid: () => uid,
    currentUser: () => 'tester',
  }
}

describe('parseEnvFile', () => {
  test('parses simple KEY=VALUE lines', () => {
    expect(parseEnvFile('A=1\nB=two\n')).toEqual({ A: '1', B: 'two' })
  })
  test('skips comments and blanks', () => {
    expect(parseEnvFile('# comment\n\nA=1\n   \nB=2\n')).toEqual({ A: '1', B: '2' })
  })
  test('strips matched outer single/double quotes', () => {
    expect(parseEnvFile('A="hello"\nB=\'world\'\n')).toEqual({ A: 'hello', B: 'world' })
  })
  test('keeps mismatched quotes verbatim', () => {
    expect(parseEnvFile('A="x\nB=y"\n')).toEqual({ A: '"x', B: 'y"' })
  })
  test('rejects keys with invalid identifiers', () => {
    expect(parseEnvFile('1BAD=x\nGOOD_1=ok\n')).toEqual({ GOOD_1: 'ok' })
  })
  test('keeps the `=` in the value when value contains =', () => {
    expect(parseEnvFile('URL=https://x.example/?a=b&c=d\n')).toEqual({
      URL: 'https://x.example/?a=b&c=d',
    })
  })
  test('does not evaluate expansions or shell metacharacters', () => {
    // Critical: a value containing $(rm -rf /) MUST land as the literal string.
    const vars = parseEnvFile('SHELL_BOMB=$(rm -rf /)\nVAR_REF=${HOME}\n')
    expect(vars.SHELL_BOMB).toBe('$(rm -rf /)')
    expect(vars.VAR_REF).toBe('${HOME}')
  })
})

describe('loadEnv', () => {
  test('returns vars + labels on a valid file', () => {
    const file = envText(minimalEnv({ LABEL_PREFIX: 'mt.test' }))
    const out = loadEnv({ path: '/fake/.env', deps: fakeDeps({ fileText: file }) })
    expect(out.vars.LABEL_PREFIX).toBe('mt.test')
    expect(out.labels.web).toBe('mt.test.web')
    expect(out.labels.mcp).toBe('mt.test.mcp')
    expect(out.labels.tunnelWeb).toBe('mt.test.cloudflared.web')
    expect(out.labels.watchdog).toBe('mt.test.watchdog')
    expect(out.labels.autoroll).toBe('mt.test.autoroll')
  })

  test('synthesises the weekly auto-roll label + schedule defaults', () => {
    const file = envText(minimalEnv({ LABEL_PREFIX: 'mt.test' }))
    const out = loadEnv({ path: '/fake/.env', deps: fakeDeps({ fileText: file }) })
    expect(out.vars.LABEL_AUTOROLL).toBe('mt.test.autoroll')
    expect(out.vars.AUTOROLL_WEEKDAY).toBe('0') // Sunday
    expect(out.vars.AUTOROLL_HOUR).toBe('14')
  })

  test('respects an explicit auto-roll schedule from .env', () => {
    const file = envText(minimalEnv({ LABEL_PREFIX: 'mt.test', AUTOROLL_WEEKDAY: '1', AUTOROLL_HOUR: '9' }))
    const out = loadEnv({ path: '/fake/.env', deps: fakeDeps({ fileText: file }) })
    expect(out.vars.AUTOROLL_WEEKDAY).toBe('1')
    expect(out.vars.AUTOROLL_HOUR).toBe('9')
  })

  test('throws missing when stat fails', () => {
    const deps = fakeDeps()
    deps.stat = () => { throw new Error('ENOENT') }
    expect(() => loadEnv({ path: '/nope', deps })).toThrow(EnvLoadError)
  })

  test('throws wrong-owner when uid differs', () => {
    const deps = fakeDeps({ uid: 1000 })
    deps.currentUid = () => 2000
    try {
      loadEnv({ path: '/fake', deps })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnvLoadError)
      expect(err.code).toBe('wrong-owner')
      expect(err.exitCode).toBe(78)
    }
  })

  test('under sudo (root) accepts a .env owned by the SUDO_UID operator', () => {
    const deps = fakeDeps({ uid: 501, fileText: envText(minimalEnv({ LABEL_PREFIX: 'mt.test' })) })
    deps.currentUid = () => 0 // running as root via sudo
    deps.sudoUid = 501 // ... but the invoking operator is uid 501
    const out = loadEnv({ path: '/fake', deps })
    expect(out.vars.LABEL_PREFIX).toBe('mt.test')
  })

  test('under sudo still rejects a .env owned by a third party', () => {
    const deps = fakeDeps({ uid: 999, fileText: envText(minimalEnv()) })
    deps.currentUid = () => 0
    deps.sudoUid = 501 // operator is 501, but the file is owned by 999
    expect(() => loadEnv({ path: '/fake', deps })).toThrow(/wrong-owner|owner uid/)
  })

  test('throws wrong-mode when mode is too permissive', () => {
    const deps = fakeDeps({ mode: 0o644, fileText: envText(minimalEnv()) })
    try {
      loadEnv({ path: '/fake', deps })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnvLoadError)
      expect(err.code).toBe('wrong-mode')
      expect(err.message).toContain('0644')
    }
  })

  test('honours skipOwnerCheck / skipModeCheck escape hatches', () => {
    const deps = fakeDeps({ uid: 1, mode: 0o777, fileText: envText(minimalEnv()) })
    deps.currentUid = () => 9999
    const out = loadEnv({ path: '/fake', skipOwnerCheck: true, skipModeCheck: true, deps })
    expect(out.vars.USER_NAME).toBe('user_name-value')
  })

  test('throws missing-required when a required var is absent', () => {
    const env = minimalEnv()
    delete env.LABEL_PREFIX
    const deps = fakeDeps({ fileText: envText(env) })
    try {
      loadEnv({ path: '/fake', deps })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err.code).toBe('missing-required')
      expect(err.message).toContain('LABEL_PREFIX')
    }
  })

  test('synthesises STATIC_DIR from REPO_DIR when not set', () => {
    const file = envText(minimalEnv({ REPO_DIR: '/srv/apple-docs', LABEL_PREFIX: 'p' }))
    const out = loadEnv({ path: '/fake', deps: fakeDeps({ fileText: file }) })
    expect(out.staticDir).toBe('/srv/apple-docs/dist/web')
  })

  test('honours an explicit STATIC_DIR override', () => {
    const file = envText(minimalEnv({
      REPO_DIR: '/srv/apple-docs',
      STATIC_DIR: '/var/www/apple-docs',
      LABEL_PREFIX: 'p',
    }))
    const out = loadEnv({ path: '/fake', deps: fakeDeps({ fileText: file }) })
    expect(out.staticDir).toBe('/var/www/apple-docs')
  })
})

describe('SNAPSHOT_CHANNEL', () => {
  test('defaults to stable', () => {
    const out = loadEnv({ path: '/fake/.env', deps: fakeDeps({ fileText: envText(minimalEnv()) }) })
    expect(out.vars.SNAPSHOT_CHANNEL).toBe('stable')
  })

  test('accepts beta', () => {
    const out = loadEnv({ path: '/fake/.env', deps: fakeDeps({ fileText: envText(minimalEnv({ SNAPSHOT_CHANNEL: 'beta' })) }) })
    expect(out.vars.SNAPSHOT_CHANNEL).toBe('beta')
  })

  test('rejects anything else', () => {
    expect(() => loadEnv({
      path: '/fake/.env',
      deps: fakeDeps({ fileText: envText(minimalEnv({ SNAPSHOT_CHANNEL: 'nightly' })) }),
    })).toThrow(EnvLoadError)
  })
})

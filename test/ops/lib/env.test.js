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

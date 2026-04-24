import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveGitHubAuth, readSidecar, writeSidecar } from '../../src/lib/git-auth-resolve.js'
import { setResolvedGitHubToken, getGitHubToken } from '../../src/lib/github.js'

// `getGitHubToken` is imported for the "detected token is installed" assertions.
void getGitHubToken

let tmpHome
let sidecarPath

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'apple-docs-auth-'))
  sidecarPath = join(tmpHome, 'config.json')
  setResolvedGitHubToken(null)
})

afterEach(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  setResolvedGitHubToken(null)
})

function loggerStub() {
  const calls = { debug: [], info: [], warn: [], error: [] }
  return {
    calls,
    debug: (m) => calls.debug.push(m),
    info: (m) => calls.info.push(m),
    warn: (m) => calls.warn.push(m),
    error: (m) => calls.error.push(m),
  }
}

function neverDetect() {
  return async () => { throw new Error('detect should not run') }
}

describe('resolveGitHubAuth', () => {
  test('returns early when GITHUB_TOKEN is set', async () => {
    const res = await resolveGitHubAuth({
      flags: {},
      env: { GITHUB_TOKEN: 'envtok' },
      detect: neverDetect(),
      isTTY: () => true,
      sidecarPath,
    })
    expect(res.source).toBe('env')
  })

  test('returns early when APPLE_DOCS_NO_GIT_AUTH=1', async () => {
    const res = await resolveGitHubAuth({
      flags: {},
      env: { APPLE_DOCS_NO_GIT_AUTH: '1' },
      detect: neverDetect(),
      isTTY: () => true,
      sidecarPath,
    })
    expect(res.token).toBeNull()
    expect(res.source).toBeNull()
  })

  test('returns early when --skip-git-auth is set', async () => {
    const res = await resolveGitHubAuth({
      flags: { 'skip-git-auth': true },
      env: {},
      detect: neverDetect(),
      isTTY: () => true,
      sidecarPath,
    })
    expect(res.token).toBeNull()
  })

  test('--use-git-auth detects without prompting', async () => {
    const logger = loggerStub()
    const promptFn = async () => { throw new Error('prompt should not run') }
    const res = await resolveGitHubAuth({
      flags: { 'use-git-auth': true },
      env: {},
      logger,
      detect: async () => ({ token: 'tok_use', source: 'gh' }),
      promptFn,
      isTTY: () => true,
      sidecarPath,
    })
    expect(res).toEqual({ token: 'tok_use', source: 'gh' })
    expect(getGitHubToken()).toBe('tok_use')
  })

  test('--use-git-auth with no detected token warns and returns null', async () => {
    const logger = loggerStub()
    const res = await resolveGitHubAuth({
      flags: { 'use-git-auth': true },
      env: {},
      logger,
      detect: async () => null,
      isTTY: () => true,
      sidecarPath,
    })
    expect(res.token).toBeNull()
    expect(logger.calls.warn.length).toBe(1)
  })

  test('persisted useGitAuth=true bypasses prompt', async () => {
    mkdirSync(tmpHome, { recursive: true })
    writeFileSync(sidecarPath, JSON.stringify({ useGitAuth: true }))
    const promptFn = async () => { throw new Error('prompt should not run') }

    const res = await resolveGitHubAuth({
      flags: {},
      env: {},
      detect: async () => ({ token: 'persisted', source: 'gh' }),
      promptFn,
      isTTY: () => true,
      sidecarPath,
    })
    expect(res.token).toBe('persisted')
  })

  test('persisted useGitAuth=false short-circuits in the absence of flag', async () => {
    mkdirSync(tmpHome, { recursive: true })
    writeFileSync(sidecarPath, JSON.stringify({ useGitAuth: false }))

    const res = await resolveGitHubAuth({
      flags: {},
      env: {},
      detect: neverDetect(),
      isTTY: () => true,
      sidecarPath,
    })
    expect(res.token).toBeNull()
  })

  test('--use-git-auth overrides persisted useGitAuth=false', async () => {
    mkdirSync(tmpHome, { recursive: true })
    writeFileSync(sidecarPath, JSON.stringify({ useGitAuth: false }))

    const res = await resolveGitHubAuth({
      flags: { 'use-git-auth': true },
      env: {},
      detect: async () => ({ token: 'override_tok', source: 'gh' }),
      isTTY: () => false,
      sidecarPath,
    })
    expect(res.token).toBe('override_tok')
    expect(res.source).toBe('gh')
  })

  test('prompt yes: uses token, does not persist', async () => {
    const res = await resolveGitHubAuth({
      flags: {},
      env: {},
      detect: async () => ({ token: 'once', source: 'gh' }),
      promptFn: async () => 'yes',
      isTTY: () => true,
      sidecarPath,
    })
    expect(res.token).toBe('once')
    expect(readSidecar(sidecarPath)).toBeNull()
  })

  test('prompt always: uses token and persists useGitAuth=true', async () => {
    const res = await resolveGitHubAuth({
      flags: {},
      env: {},
      detect: async () => ({ token: 'forever', source: 'git-credential' }),
      promptFn: async () => 'always',
      isTTY: () => true,
      sidecarPath,
    })
    expect(res.token).toBe('forever')
    const persisted = readSidecar(sidecarPath)
    expect(persisted?.useGitAuth).toBe(true)
  })

  test('prompt no: returns null and does not persist', async () => {
    const res = await resolveGitHubAuth({
      flags: {},
      env: {},
      detect: async () => ({ token: 'declined', source: 'gh' }),
      promptFn: async () => 'no',
      isTTY: () => true,
      sidecarPath,
    })
    expect(res.token).toBeNull()
    expect(readSidecar(sidecarPath)).toBeNull()
    expect(getGitHubToken()).toBeNull()
  })

  test('non-TTY without flag returns null without detecting', async () => {
    const res = await resolveGitHubAuth({
      flags: {},
      env: {},
      detect: neverDetect(),
      isTTY: () => false,
      sidecarPath,
    })
    expect(res.token).toBeNull()
  })

  test('TTY but no detected token returns null silently', async () => {
    const res = await resolveGitHubAuth({
      flags: {},
      env: {},
      detect: async () => null,
      promptFn: async () => { throw new Error('should not prompt') },
      isTTY: () => true,
      sidecarPath,
    })
    expect(res.token).toBeNull()
  })
})

describe('sidecar helpers', () => {
  test('writeSidecar sets 0600 and round-trips through readSidecar', () => {
    writeSidecar(sidecarPath, { useGitAuth: true, extra: 1 })
    const stat = statSync(sidecarPath)
    // Compare only the permission bits.
    expect(stat.mode & 0o777).toBe(0o600)
    expect(readSidecar(sidecarPath)).toEqual({ useGitAuth: true, extra: 1 })
  })

  test('readSidecar returns null on malformed JSON', () => {
    writeFileSync(sidecarPath, '{not json')
    expect(readSidecar(sidecarPath)).toBeNull()
  })

  test('readSidecar returns null when file is missing', () => {
    expect(readSidecar(join(tmpHome, 'missing.json'))).toBeNull()
  })
})

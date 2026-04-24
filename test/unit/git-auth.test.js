import { describe, test, expect } from 'bun:test'
import { detectLocalGitHubToken, _test } from '../../src/lib/git-auth.js'

/**
 * Build a fake spawn factory driven by a list of canned responses keyed by the
 * first arg of the command. Each response describes exit code, stdout, stderr,
 * optional delay, and optional `throw: true` to simulate spawn failure.
 */
function makeFakeSpawn(scripts) {
  return (cmd /*, opts */) => {
    const name = cmd[0]
    const script = scripts[name]
    if (!script) {
      throw new Error(`unexpected command: ${cmd.join(' ')}`)
    }
    if (script.throw) {
      throw new Error('spawn failed')
    }
    const encode = (str) => new TextEncoder().encode(str ?? '')
    const stdoutStream = new ReadableStream({
      start(controller) { controller.enqueue(encode(script.stdout)); controller.close() },
    })
    const stderrStream = new ReadableStream({
      start(controller) { controller.enqueue(encode(script.stderr)); controller.close() },
    })
    const exited = new Promise((resolve) => {
      if (script.hang) return // never resolves
      setTimeout(() => resolve(script.code ?? 0), script.delay ?? 0)
    })
    let stdinPayload = ''
    const stdin = {
      getWriter() {
        return {
          write: async (chunk) => {
            stdinPayload += new TextDecoder().decode(chunk)
          },
          close: async () => {},
        }
      },
      _read() { return stdinPayload },
    }
    return {
      stdin,
      stdout: stdoutStream,
      stderr: stderrStream,
      exited,
      kill() {},
    }
  }
}

describe('detectLocalGitHubToken', () => {
  test('returns token from gh when available', async () => {
    const spawn = makeFakeSpawn({
      gh: { code: 0, stdout: 'ghp_fake_token\n' },
    })
    const which = (name) => (name === 'gh' ? '/usr/bin/gh' : null)

    const result = await detectLocalGitHubToken({ spawn, which })
    expect(result).toEqual({ token: 'ghp_fake_token', source: 'gh' })
  })

  test('trims whitespace from gh output', async () => {
    const spawn = makeFakeSpawn({
      gh: { code: 0, stdout: '  ghp_padded  \n' },
    })
    const which = () => '/usr/bin/gh'
    const result = await detectLocalGitHubToken({ spawn, which })
    expect(result?.token).toBe('ghp_padded')
  })

  test('falls back to git credential when gh is missing', async () => {
    const spawn = makeFakeSpawn({
      git: {
        code: 0,
        stdout: 'protocol=https\nhost=github.com\nusername=x\npassword=ghp_from_git\n',
      },
    })
    const which = (name) => (name === 'git' ? '/usr/bin/git' : null)

    const result = await detectLocalGitHubToken({ spawn, which })
    expect(result).toEqual({ token: 'ghp_from_git', source: 'git-credential' })
  })

  test('falls back to git credential when gh exits non-zero', async () => {
    const spawn = makeFakeSpawn({
      gh: { code: 1, stdout: '', stderr: 'not logged in' },
      git: { code: 0, stdout: 'password=tok\n' },
    })
    const which = (name) => (name === 'gh' ? '/usr/bin/gh' : '/usr/bin/git')

    const result = await detectLocalGitHubToken({ spawn, which })
    expect(result?.source).toBe('git-credential')
    expect(result?.token).toBe('tok')
  })

  test('returns null when gh exits non-zero and git has no password line', async () => {
    const spawn = makeFakeSpawn({
      gh: { code: 1, stdout: '' },
      git: { code: 0, stdout: 'protocol=https\nhost=github.com\n' },
    })
    const which = () => '/usr/bin/whatever'

    const result = await detectLocalGitHubToken({ spawn, which })
    expect(result).toBeNull()
  })

  test('returns null when neither binary exists', async () => {
    const spawn = makeFakeSpawn({})
    const which = () => null
    const result = await detectLocalGitHubToken({ spawn, which })
    expect(result).toBeNull()
  })

  test('returns null when spawn throws', async () => {
    const spawn = () => { throw new Error('boom') }
    const which = () => '/usr/bin/gh'
    const result = await detectLocalGitHubToken({ spawn, which })
    expect(result).toBeNull()
  })

  test('times out and returns null when child hangs', async () => {
    const spawn = makeFakeSpawn({
      gh: { hang: true },
    })
    const which = (name) => (name === 'gh' ? '/usr/bin/gh' : null)

    const result = await detectLocalGitHubToken({ spawn, which, timeoutMs: 25 })
    expect(result).toBeNull()
  })

  test('ignores empty stdout from gh and keeps trying git', async () => {
    const spawn = makeFakeSpawn({
      gh: { code: 0, stdout: '' },
      git: { code: 0, stdout: 'password=from_git\n' },
    })
    const which = () => '/usr/bin/x'

    const result = await detectLocalGitHubToken({ spawn, which })
    expect(result?.source).toBe('git-credential')
  })
})

describe('safeEnv', () => {
  test('keeps only the allowlisted keys and forces GIT_TERMINAL_PROMPT=0', () => {
    const out = _test.safeEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      USER: 'u',
      SECRET_KEY: 'leak',
    })
    expect(out.PATH).toBe('/usr/bin')
    expect(out.HOME).toBe('/home/u')
    expect(out.USER).toBe('u')
    expect(out.GIT_TERMINAL_PROMPT).toBe('0')
    expect(out.SECRET_KEY).toBeUndefined()
  })
})

describe('parseGitCredentialOutput', () => {
  test('returns the password field value', () => {
    const out = _test.parseGitCredentialOutput(
      'protocol=https\nhost=github.com\nusername=x\npassword=secret\n',
    )
    expect(out).toBe('secret')
  })

  test('returns null when there is no password line', () => {
    expect(_test.parseGitCredentialOutput('host=github.com\n')).toBeNull()
  })

  test('returns null for empty input', () => {
    expect(_test.parseGitCredentialOutput('')).toBeNull()
  })
})

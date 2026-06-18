import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { _resetCommitHash, getCommitHash } from '../../../src/lib/git-version.js'

// Reset the process-wide memoization cache BEFORE each test as well as after:
// getCommitHash() caches its first resolution, so another test file that
// resolves it earlier in the run would leave the real HEAD cached and the
// first test here would read that instead of the env it sets. beforeEach
// isolates this file from cross-file execution order.
beforeEach(() => {
  _resetCommitHash()
  delete process.env.APPLE_DOCS_COMMIT
})

afterEach(() => {
  _resetCommitHash()
  delete process.env.APPLE_DOCS_COMMIT
})

describe('getCommitHash', () => {
  test('prefers a valid APPLE_DOCS_COMMIT env (lowercased)', () => {
    process.env.APPLE_DOCS_COMMIT = 'DEADBEEF'
    expect(getCommitHash()).toBe('deadbeef')
  })

  test('rejects a non-SHA env (no HTML/URL injection) and never returns the junk', () => {
    process.env.APPLE_DOCS_COMMIT = 'not a sha"><script>'
    const sha = getCommitHash()
    // Falls through to `git` (a real short SHA in this repo) or null — never the junk.
    expect(sha === null || /^[0-9a-f]{7,40}$/.test(sha)).toBe(true)
  })

  test('memoizes the first resolution', () => {
    process.env.APPLE_DOCS_COMMIT = 'abcdef0'
    const first = getCommitHash()
    expect(first).toBe('abcdef0')
    delete process.env.APPLE_DOCS_COMMIT
    expect(getCommitHash()).toBe(first) // cached, not re-read
  })
})

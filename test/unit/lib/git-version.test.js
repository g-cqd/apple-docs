import { describe, test, expect, afterEach } from 'bun:test'
import { getCommitHash, _resetCommitHash } from '../../../src/lib/git-version.js'

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

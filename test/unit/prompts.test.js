import { describe, test, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { promptYesNoAlways, interpretAnswer } from '../../src/cli/prompts.js'

function drive(answer) {
  const input = new PassThrough()
  const output = new PassThrough()
  // Drain output so readline's `question` prompt write resolves.
  output.resume()
  const promise = promptYesNoAlways('continue?', { input, output })
  // Queue the answer on the next tick so readline has a chance to subscribe.
  setImmediate(() => {
    input.write(`${answer}\n`)
    input.end()
  })
  return promise
}

describe('promptYesNoAlways', () => {
  test('returns "yes" on "y"', async () => {
    expect(await drive('y')).toBe('yes')
  })

  test('returns "yes" on "yes"', async () => {
    expect(await drive('yes')).toBe('yes')
  })

  test('returns "no" on "n"', async () => {
    expect(await drive('n')).toBe('no')
  })

  test('returns "no" on empty input', async () => {
    expect(await drive('')).toBe('no')
  })

  test('returns "always" on "always"', async () => {
    expect(await drive('always')).toBe('always')
  })

  test('returns "always" on "a"', async () => {
    expect(await drive('a')).toBe('always')
  })

  test('is case-insensitive', async () => {
    expect(await drive('YES')).toBe('yes')
    expect(await drive('Always')).toBe('always')
  })
})

describe('interpretAnswer', () => {
  test('treats unknown input as "no"', () => {
    expect(interpretAnswer('maybe')).toBe('no')
    expect(interpretAnswer(undefined)).toBe('no')
    expect(interpretAnswer(null)).toBe('no')
  })
})

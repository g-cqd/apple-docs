import { describe, test, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { promptYesNoAlways, interpretAnswer, promptChoice, interpretChoice } from '../../../src/cli/prompts.js'

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

const CHOICES = [
  { label: 'Render on demand', value: 'balanced' },
  { label: 'Prebuilt', value: 'prebuilt' },
]

function driveChoice(answer, opts = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const promise = promptChoice('pick a profile:', CHOICES, { input, output, ...opts })
  setImmediate(() => {
    input.write(`${answer}\n`)
    input.end()
  })
  return promise
}

describe('promptChoice', () => {
  test('selects by 1-based index', async () => {
    expect(await driveChoice('2')).toBe('prebuilt')
  })

  test('selects by value name', async () => {
    expect(await driveChoice('prebuilt')).toBe('prebuilt')
  })

  test('selects by label (case-insensitive)', async () => {
    expect(await driveChoice('RENDER ON DEMAND')).toBe('balanced')
  })

  test('empty input falls back to the default choice', async () => {
    expect(await driveChoice('')).toBe('balanced')
  })

  test('honors a non-zero defaultIndex on empty input', async () => {
    expect(await driveChoice('', { defaultIndex: 1 })).toBe('prebuilt')
  })

  test('unknown input falls back to the default choice', async () => {
    expect(await driveChoice('garbage')).toBe('balanced')
  })
})

describe('interpretChoice', () => {
  test('out-of-range index falls back to the default', () => {
    expect(interpretChoice('9', CHOICES, 0)).toBe('balanced')
  })

  test('respects defaultIndex for empty input', () => {
    expect(interpretChoice('', CHOICES, 1)).toBe('prebuilt')
  })
})

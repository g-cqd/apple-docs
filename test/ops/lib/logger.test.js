import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger, isoOffset } from '../../../ops/lib/logger.js'

function captureStream() {
  const chunks = []
  return { chunks, write(s) { chunks.push(s) } }
}

describe('isoOffset', () => {
  test('formats with date components and TZ offset', () => {
    // 2026-05-13T02:31:02 in a -05:00 timezone is the expected shape.
    const d = new Date(Date.UTC(2026, 4, 13, 7, 31, 2))
    const s = isoOffset(d)
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })
  test('zero-pads single-digit fields', () => {
    const d = new Date(Date.UTC(2026, 0, 3, 4, 5, 6))
    expect(isoOffset(d)).toMatch(/2026-01-03T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)
  })
})

describe('createLogger', () => {
  test('say() writes a timestamped line to the stream', () => {
    const stream = captureStream()
    const fixed = new Date('2026-05-13T02:31:02Z')
    const log = createLogger({ stream, clock: () => fixed })
    log.say('hello')
    expect(stream.chunks).toHaveLength(1)
    expect(stream.chunks[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] hello\n$/)
  })

  test('warn() / error() use the matching prefix', () => {
    const stream = captureStream()
    const log = createLogger({ stream, clock: () => new Date('2026-05-13T00:00:00Z') })
    log.warn('soft')
    log.error('hard')
    expect(stream.chunks[0]).toContain('WARN: soft')
    expect(stream.chunks[1]).toContain('ERROR: hard')
  })

  test('runStart() prints the joined command with a $ prefix', () => {
    const stream = captureStream()
    const log = createLogger({ stream, clock: () => new Date('2026-05-13T00:00:00Z') })
    log.runStart('launchctl', ['bootout', 'system/mt.everest.apple-docs.web'])
    expect(stream.chunks[0]).toContain('$ launchctl bootout system/mt.everest.apple-docs.web\n')
  })

  test('runOutput() passes its chunk through verbatim', () => {
    const stream = captureStream()
    const log = createLogger({ stream, clock: () => new Date() })
    log.runOutput('chunk-without-newline')
    log.runOutput('chunk-with-newline\n')
    expect(stream.chunks).toEqual(['chunk-without-newline', 'chunk-with-newline\n'])
  })

  test('logPath() tees output to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'logger-test-'))
    const logPath = join(dir, 'a/b/out.log')  // ensure mkdir -p path
    try {
      const log = createLogger({ logPath, stream: { write() {} } })
      log.say('to disk')
      const content = readFileSync(logPath, 'utf8')
      expect(content).toContain('to disk')
      expect(log.logPath()).toBe(logPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('runOutput("") is a no-op', () => {
    const stream = captureStream()
    const log = createLogger({ stream, clock: () => new Date() })
    log.runOutput('')
    expect(stream.chunks).toEqual([])
  })
})

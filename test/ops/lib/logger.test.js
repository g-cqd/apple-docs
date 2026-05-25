import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger, isoOffset, redactSensitive } from '../../../ops/lib/logger.js'

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

  test('redacts bearer tokens and HTTP auth headers from runOutput', () => {
    const stream = captureStream()
    const log = createLogger({ stream, clock: () => new Date() })
    log.runOutput('> GET /foo\n> Authorization: Bearer abc123secret\n> Cookie: session=xyz\n')
    const out = stream.chunks.join('')
    expect(out).toContain('Authorization: <redacted>')
    expect(out).toContain('Cookie: <redacted>')
    expect(out).not.toContain('abc123secret')
    expect(out).not.toContain('xyz')
  })

  test('redacts JSON token fields', () => {
    const stream = captureStream()
    const log = createLogger({ stream, clock: () => new Date() })
    log.runOutput('{"token":"abc-token-1","status":"ok"}')
    const out = stream.chunks.join('')
    expect(out).toContain('"token":"<redacted>"')
    expect(out).not.toContain('abc-token-1')
    expect(out).toContain('"status":"ok"')
  })

  test('redacts URL query-string credentials', () => {
    const stream = captureStream()
    const log = createLogger({ stream, clock: () => new Date() })
    log.runOutput('curl https://api.example.com/v1?api_key=hunter2&safe=ok\n')
    const out = stream.chunks.join('')
    expect(out).toContain('api_key=<redacted>')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('safe=ok')
  })
})

describe('redactSensitive', () => {
  test('passes through ordinary text', () => {
    expect(redactSensitive('hello world')).toBe('hello world')
    expect(redactSensitive('')).toBe('')
  })

  test('redacts Authorization header value', () => {
    expect(redactSensitive('Authorization: Bearer abc123')).toContain('<redacted>')
    expect(redactSensitive('Authorization: Bearer abc123')).not.toContain('abc123')
  })

  test('redacts JSON token property', () => {
    const out = redactSensitive('{"bearer":"xyz","ok":true}')
    expect(out).toContain('"bearer":"<redacted>"')
    expect(out).not.toContain('xyz')
  })

  test('redacts Basic-auth Authorization headers', () => {
    const out = redactSensitive('Authorization: Basic dXNlcjpwYXNz')
    expect(out).toContain('Authorization: <redacted>')
    expect(out).not.toContain('dXNlcjpwYXNz')
  })

  test('redacts Set-Cookie response headers', () => {
    const out = redactSensitive('Set-Cookie: session=abc123; Path=/; HttpOnly')
    // The redactor matches `cookie` case-insensitively in both directions.
    expect(out).toContain('<redacted>')
    expect(out).not.toContain('abc123')
  })

  test('redacts custom X-Auth-Token headers', () => {
    const out = redactSensitive('X-Auth-Token: 02e9d8...')
    expect(out).toContain('X-Auth-Token: <redacted>')
    expect(out).not.toContain('02e9d8')
  })

  test('redacts Cloudflare token header', () => {
    const out = redactSensitive('X-Cloudflare-Token: deadbeef')
    expect(out).toContain('X-Cloudflare-Token: <redacted>')
    expect(out).not.toContain('deadbeef')
  })

  test('redacts AWS security token header', () => {
    const out = redactSensitive('X-Amz-Security-Token: AQoDYXdzEJr...')
    expect(out).toContain('X-Amz-Security-Token: <redacted>')
    expect(out).not.toContain('AQoDYXdzEJr')
  })

  test('redacts multi-key JSON payloads', () => {
    const out = redactSensitive('{"api_key":"k1","password":"p1","name":"safe"}')
    expect(out).toContain('"api_key":"<redacted>"')
    expect(out).toContain('"password":"<redacted>"')
    expect(out).toContain('"name":"safe"')
    expect(out).not.toContain('k1')
    expect(out).not.toContain('p1')
  })

  test('redacts URL query strings with access_token / auth', () => {
    expect(redactSensitive('https://x?access_token=q1')).toContain('access_token=<redacted>')
    expect(redactSensitive('https://x?auth=q2&z=ok')).toContain('auth=<redacted>')
    expect(redactSensitive('https://x?auth=q2&z=ok')).toContain('z=ok')
  })

  test('is a no-op for non-string inputs', () => {
    expect(redactSensitive(undefined)).toBe(undefined)
    expect(redactSensitive(null)).toBe(null)
    expect(redactSensitive(42)).toBe(42)
  })
})

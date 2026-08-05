/**
 * Stream routing for the JSON logger.
 *
 * The default (everything → stderr) is load-bearing: `apple-docs mcp start`
 * speaks JSON-RPC over stdout, so a log line there corrupts the protocol.
 * The opt-in split exists because a long-lived HTTP daemon otherwise writes
 * its whole request log to the "error" file — 199 MB of `info` on the
 * reference deployment, with real failures buried in it.
 */

import { describe, expect, test } from 'bun:test'
import { createLogger } from '../../../src/lib/logger.js'

function capture(fn) {
  const out = []
  const err = []
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true }
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true }
  try { fn() } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
  return { out: out.join(''), err: err.join('') }
}

describe('logger stream routing', () => {
  test('defaults to stderr for every level (stdio MCP safety)', () => {
    const { out, err } = capture(() => {
      const log = createLogger('debug', { splitStreams: false })
      log.debug('d'); log.info('i'); log.warn('w'); log.error('e')
    })
    expect(out).toBe('')
    for (const level of ['debug', 'info', 'warn', 'error']) {
      expect(err).toContain(`"level":"${level}"`)
    }
  })

  test('splitStreams sends debug/info to stdout and warn/error to stderr', () => {
    const { out, err } = capture(() => {
      const log = createLogger('debug', { splitStreams: true })
      log.debug('d'); log.info('i'); log.warn('w'); log.error('e')
    })
    expect(out).toContain('"level":"debug"')
    expect(out).toContain('"level":"info"')
    expect(out).not.toContain('"level":"warn"')
    expect(out).not.toContain('"level":"error"')

    expect(err).toContain('"level":"warn"')
    expect(err).toContain('"level":"error"')
    expect(err).not.toContain('"level":"info"')
  })

  test('child loggers from withRequestId keep the routing', () => {
    const { out, err } = capture(() => {
      const log = createLogger('info', { splitStreams: true }).withRequestId('abc')
      log.info('i'); log.error('e')
    })
    expect(out).toContain('"requestId":"abc"')
    expect(out).toContain('"level":"info"')
    expect(err).toContain('"level":"error"')
  })

  test('explicit splitStreams beats the env var', () => {
    const prev = process.env.APPLE_DOCS_LOG_STDOUT
    process.env.APPLE_DOCS_LOG_STDOUT = '1'
    try {
      const { out, err } = capture(() => {
        createLogger('info', { splitStreams: false }).info('i')
      })
      expect(out).toBe('')
      expect(err).toContain('"level":"info"')
    } finally {
      if (prev === undefined) delete process.env.APPLE_DOCS_LOG_STDOUT
      else process.env.APPLE_DOCS_LOG_STDOUT = prev
    }
  })
})

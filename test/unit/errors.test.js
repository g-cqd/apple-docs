import { describe, expect, test } from 'bun:test'
import {
  BackpressureError,
  BodyTooLargeError,
  HttpError,
  NotFoundError,
  ParseError,
  ValidationError,
} from '../../src/lib/errors.js'

describe('typed errors', () => {
  test('HttpError carries status, url, name', () => {
    const err = new HttpError(503, 'https://x.test/y')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.name).toBe('HttpError')
    expect(err.status).toBe(503)
    expect(err.url).toBe('https://x.test/y')
    expect(err.message).toContain('503')
    expect(err.message).toContain('https://x.test/y')
  })

  test('NotFoundError extends HttpError with status 404', () => {
    const err = new NotFoundError('https://x.test/y')
    expect(err).toBeInstanceOf(HttpError)
    expect(err).toBeInstanceOf(NotFoundError)
    expect(err.name).toBe('NotFoundError')
    expect(err.status).toBe(404)
    // Legacy callers that sniff `err?.status === 404` still match.
    expect(err.status === 404).toBe(true)
  })

  test('ParseError preserves cause and source tag', () => {
    const cause = new SyntaxError('bad json')
    const err = new ParseError('payload bad', { cause, source: 'packages' })
    expect(err).toBeInstanceOf(ParseError)
    expect(err.name).toBe('ParseError')
    expect(err.cause).toBe(cause)
    expect(err.source).toBe('packages')
  })

  test('ValidationError preserves field and value', () => {
    const err = new ValidationError('bad sourceType', { field: 'sourceType', value: 'nope' })
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.field).toBe('sourceType')
    expect(err.value).toBe('nope')
  })

  test('re-exports BackpressureError and BodyTooLargeError', () => {
    expect(typeof BackpressureError).toBe('function')
    expect(typeof BodyTooLargeError).toBe('function')
  })
})

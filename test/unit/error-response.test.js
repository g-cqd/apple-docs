import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { errorResponse } from '../../src/web/responses.js'

describe('errorResponse (A27 stack-trace stripping)', () => {
  let originalEnv

  beforeEach(() => { originalEnv = process.env.NODE_ENV })
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalEnv
  })

  test('exposes stack in development (default)', async () => {
    process.env.NODE_ENV = 'development'
    const res = errorResponse(new Error('boom'))
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body.error).toBe('boom')
    expect(body.stack).toBeDefined()
  })

  test('strips stack in production', async () => {
    process.env.NODE_ENV = 'production'
    const res = errorResponse(new Error('leak me'))
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body.error).toBe('leak me')
    expect(body.stack).toBeUndefined()
  })

  test('exposeStack=false overrides NODE_ENV', async () => {
    process.env.NODE_ENV = 'development'
    const res = errorResponse(new Error('hidden'), { exposeStack: false })
    const body = await res.json()
    expect(body.stack).toBeUndefined()
  })

  test('accepts a status code', async () => {
    const res = errorResponse('bad input', { status: 400 })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('bad input')
  })

  test('handles string errors', async () => {
    const res = errorResponse('something went wrong')
    const body = await res.json()
    expect(body.error).toBe('something went wrong')
    expect(body.stack).toBeUndefined() // strings have no stack
  })
})

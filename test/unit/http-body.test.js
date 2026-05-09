import { describe, test, expect } from 'bun:test'
import {
  BodyTooLargeError,
  DEFAULT_MAX_BODY_BYTES,
  readBodyCapped,
  readJsonRpcBodyCapped,
} from '../../src/lib/http-body.js'

function makeRequest({ body, headers = {} } = {}) {
  return new Request('http://test.local/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

describe('readBodyCapped', () => {
  test('reads small body unchanged', async () => {
    const text = await readBodyCapped(makeRequest({ body: '{"jsonrpc":"2.0"}' }), 1_000_000)
    expect(text).toBe('{"jsonrpc":"2.0"}')
  })

  test('returns empty string when body is null', async () => {
    const req = new Request('http://test.local/mcp', { method: 'GET' })
    const text = await readBodyCapped(req, 1_000_000)
    expect(text).toBe('')
  })

  test('rejects when Content-Length exceeds cap', async () => {
    const req = makeRequest({ body: 'a', headers: { 'content-length': '2000000' } })
    await expect(readBodyCapped(req, 1_000_000)).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  test('rejects when streamed body crosses cap', async () => {
    const oversized = 'a'.repeat(1_000_001)
    const req = makeRequest({ body: oversized })
    await expect(readBodyCapped(req, 1_000_000)).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  test('accepts body exactly at the cap', async () => {
    const exact = 'a'.repeat(1024)
    const text = await readBodyCapped(makeRequest({ body: exact }), 1024)
    expect(text.length).toBe(1024)
  })

  test('throws TypeError on invalid maxBytes', async () => {
    const req = makeRequest({ body: '' })
    await expect(readBodyCapped(req, 0)).rejects.toBeInstanceOf(TypeError)
    await expect(readBodyCapped(req, -1)).rejects.toBeInstanceOf(TypeError)
    await expect(readBodyCapped(req, 1.5)).rejects.toBeInstanceOf(TypeError)
  })
})

describe('readJsonRpcBodyCapped', () => {
  test('returns ok wrapper on small body', async () => {
    const result = await readJsonRpcBodyCapped(makeRequest({ body: '{"x":1}' }))
    expect(result).toEqual({ ok: true, body: '{"x":1}' })
  })

  test('returns 413 Response with JSON-RPC error envelope on overflow', async () => {
    const req = makeRequest({ body: 'a', headers: { 'content-length': '2000000' } })
    const result = await readJsonRpcBodyCapped(req)
    expect(result.ok).toBe(false)
    expect(result.response.status).toBe(413)
    const json = await result.response.json()
    expect(json.jsonrpc).toBe('2.0')
    expect(json.error.code).toBe(-32600)
    expect(json.error.message).toContain(String(DEFAULT_MAX_BODY_BYTES))
    expect(json.id).toBeNull()
  })

  test('caller can override the default cap', async () => {
    const req = makeRequest({ body: 'a'.repeat(2048), headers: { 'content-length': '2048' } })
    const result = await readJsonRpcBodyCapped(req, 1024)
    expect(result.ok).toBe(false)
    expect(result.response.status).toBe(413)
  })
})

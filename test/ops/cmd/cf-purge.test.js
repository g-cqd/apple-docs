import { describe, test, expect } from 'bun:test'
import runCfPurge from '../../../ops/cmd/cf-purge.js'

function captureLogger() {
  const chunks = []
  return {
    chunks,
    say: (m) => chunks.push({ kind: 'say', m }),
    warn: (m) => chunks.push({ kind: 'warn', m }),
    error: (m) => chunks.push({ kind: 'error', m }),
  }
}

function jsonResp({ status = 200, body = '{"success":true}' } = {}) {
  const bytes = new TextEncoder().encode(body)
  let consumed = false
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(body),
    body: new ReadableStream({
      pull(c) { if (consumed) { c.close(); return } consumed = true; c.enqueue(bytes); c.close() },
    }),
  }
}

describe('runCfPurge', () => {
  test('soft-fails (exit 0 + warn) when token is missing', async () => {
    const logger = captureLogger()
    const code = await runCfPurge({
      env: {},                            // no creds anywhere
      envLoader: () => { throw new Error('no env file') },
      logger,
    })
    expect(code).toBe(0)
    expect(logger.chunks.some(c => c.kind === 'warn' && c.m.includes('skipping edge purge'))).toBe(true)
  })

  test('issues purge_everything POST with bearer auth on success', async () => {
    let captured
    const fetcher = (url, init) => {
      captured = { url, init }
      return Promise.resolve(jsonResp({ body: '{"success":true,"errors":[]}' }))
    }
    const code = await runCfPurge({
      env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ZONE_ID: 'zoneabcd1234' },
      logger: captureLogger(),
      deps: { fetcher },
    })
    expect(code).toBe(0)
    expect(captured.url).toBe('https://api.cloudflare.com/client/v4/zones/zoneabcd1234/purge_cache')
    expect(captured.init.method).toBe('POST')
    expect(captured.init.headers.Authorization).toBe('Bearer tok')
    expect(captured.init.body).toBe('{"purge_everything":true}')
  })

  test('returns 1 on HTTP 401', async () => {
    const fetcher = () => Promise.resolve(jsonResp({ status: 401, body: '{"success":false}' }))
    const logger = captureLogger()
    const code = await runCfPurge({
      env: { CLOUDFLARE_API_TOKEN: 'bad', CLOUDFLARE_ZONE_ID: 'z' },
      logger,
      deps: { fetcher },
    })
    expect(code).toBe(1)
    expect(logger.chunks.some(c => c.kind === 'error' && c.m.includes('Cloudflare purge failed'))).toBe(true)
  })

  test('returns 1 when HTTP 200 but body says success:false', async () => {
    const fetcher = () => Promise.resolve(jsonResp({ body: '{"success":false,"errors":[{"code":1}]}' }))
    const logger = captureLogger()
    const code = await runCfPurge({
      env: { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ZONE_ID: 'z' },
      logger,
      deps: { fetcher },
    })
    expect(code).toBe(1)
    expect(logger.chunks.some(c => c.m.includes('did not report success'))).toBe(true)
  })

  test('returns 1 when body is not JSON', async () => {
    const fetcher = () => Promise.resolve(jsonResp({ body: '<html>503 from cf</html>' }))
    const code = await runCfPurge({
      env: { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ZONE_ID: 'z' },
      logger: captureLogger(),
      deps: { fetcher },
    })
    expect(code).toBe(1)
  })
})

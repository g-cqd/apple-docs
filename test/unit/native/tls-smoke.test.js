// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * TLS 1.3 + the multi-App model (RFC 0007 F1b). Boots ad-server (release) with BOTH a
 * plaintext loopback listener AND an in-process TLS listener (`--tls-cert/--tls-key/--tls-port`,
 * a per-App `Wire`), then proves: HTTPS works over the TLS listener, the plaintext loopback is
 * simultaneously up (two listeners, one shared pool), TLS negotiates TLSv1.3 + ALPN http/1.1.
 *
 * Capability test (no JS equivalent), not a byte-parity gate. Skipped when the release binary
 * or openssl is absent. The TLS listener advertises ALPN h2 + http/1.1; both serve the same
 * routes, and h1 falls back when the client doesn't offer h2.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VERSION } from '../../../src/lib/version.js'
import { DocsDatabase } from '../../../src/storage/database.js'

const AD_SERVER = new URL('../../../swift/.build/release/ad-server', import.meta.url).pathname
const PLAIN_PORT = 3047
const TLS_PORT = 3447
const HEALTH = '{"ok":true,"service":"ad-server"}'
const insecure = { tls: { rejectUnauthorized: false } }

let dir
let server
let ready = false
const haveOpenSSL = Bun.spawnSync(['openssl', 'version']).exitCode === 0
const enabled = existsSync(AD_SERVER) && haveOpenSSL

if (enabled) {
  dir = mkdtempSync(join(tmpdir(), 'tls-smoke-'))
  const dbPath = join(dir, 'corpus.db')
  new DocsDatabase(dbPath).close() // schema only — /healthz + /readyz need an openable DB, no rows
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    '1',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-subj',
    '/CN=localhost',
  ])
  server = Bun.spawn(
    [
      AD_SERVER,
      '--db',
      dbPath,
      '--port',
      String(PLAIN_PORT),
      '--tls-cert',
      certPath,
      '--tls-key',
      keyPath,
      '--tls-port',
      String(TLS_PORT),
      '--threads',
      '2',
      '--app-version',
      VERSION,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  )
}

describe.skipIf(!enabled)('TLS 1.3 + multi-App (ad-server terminates HTTPS + loopback)', () => {
  beforeAll(async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`https://127.0.0.1:${TLS_PORT}/healthz`, insecure)).ok) {
          ready = true
          break
        }
      } catch {}
      await Bun.sleep(80)
    }
  })
  afterAll(() => {
    // SIGKILL, not SIGTERM: teardown must reap unconditionally. A SIGTERM'd
    // server that cannot bind (a squatted port) or whose drain hangs would
    // outlive the run and squat the port for the NEXT run — the leak chain
    // that serially poisoned these suites once ad-server started building.
    server?.kill('SIGKILL')
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('TLS listener is reachable', () => {
    expect(ready).toBe(true)
  })

  test('HTTPS GET /healthz — 200 + ok body over TLS', async () => {
    const res = await fetch(`https://127.0.0.1:${TLS_PORT}/healthz`, insecure)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(HEALTH)
  })

  test('HTTPS GET /readyz — DB probe served through the TLS listener', async () => {
    const res = await fetch(`https://127.0.0.1:${TLS_PORT}/readyz`, insecure)
    expect(res.status).toBe(200)
    expect(JSON.parse(await res.text()).db).toBe(true)
  })

  test('the plaintext loopback listener is simultaneously up (shared pool)', async () => {
    const res = await fetch(`http://127.0.0.1:${PLAIN_PORT}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(HEALTH)
  })

  test('TLS handshake negotiates TLSv1.3 + ALPN h2', () => {
    const out = Bun.spawnSync(['sh', '-c', `echo Q | openssl s_client -connect 127.0.0.1:${TLS_PORT} -alpn h2,http/1.1 2>&1`]).stdout.toString()
    expect(out).toContain('TLSv1.3')
    expect(out).toContain('ALPN protocol: h2')
  })

  test('HTTP/2 over TLS — curl --http2 serves /healthz as h2', () => {
    const ver = Bun.spawnSync(['curl', '-sk', '--http2', '-o', '/dev/null', '-w', '%{http_version}', `https://127.0.0.1:${TLS_PORT}/healthz`])
      .stdout.toString()
      .trim()
    expect(ver).toBe('2')
    const body = Bun.spawnSync(['curl', '-sk', '--http2', `https://127.0.0.1:${TLS_PORT}/healthz`]).stdout.toString()
    expect(body).toBe(HEALTH)
  })

  test('HTTP/2 multiplexing serves a DB-backed route (/readyz) as h2', () => {
    const out = Bun.spawnSync(['curl', '-sk', '--http2', '-w', '\\n%{http_version}', `https://127.0.0.1:${TLS_PORT}/readyz`])
      .stdout.toString()
      .trim()
      .split('\n')
    expect(out[1]).toBe('2')
    expect(JSON.parse(out[0]).db).toBe(true)
  })

  test('ALPN fallback — curl --http1.1 still serves over TLS', () => {
    const ver = Bun.spawnSync(['curl', '-sk', '--http1.1', '-o', '/dev/null', '-w', '%{http_version}', `https://127.0.0.1:${TLS_PORT}/healthz`])
      .stdout.toString()
      .trim()
    expect(ver).toBe('1.1')
  })
})

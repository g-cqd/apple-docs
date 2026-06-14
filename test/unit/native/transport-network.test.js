/**
 * Apple-native transport (RFC 0007 F3). `--transport network` binds the engine on
 * NIOTransportServices (Network.framework) instead of NIOPosix; the same routes + storage
 * offload + graceful lifecycle serve identically. On non-Apple platforms `.network` falls
 * back to `.nio`, so this also passes there (it asserts route behavior, not the syscall path).
 *
 * F3a is plaintext over Network.framework; TLS over `.network` (a `sec_identity`) is F3b.
 * Capability test (no JS equivalent). Skipped when the release binary is absent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../../../src/storage/database.js'

const AD_SERVER = new URL('../../../swift/.build/release/ad-server', import.meta.url).pathname
const PORT = 3063
const HEALTH = '{"ok":true,"service":"ad-server"}'

describe.skipIf(!existsSync(AD_SERVER))('Network.framework transport (--transport network)', () => {
  let dir
  let server
  let ready = false

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'f3-'))
    new DocsDatabase(join(dir, 'corpus.db')).close()
    server = Bun.spawn(
      [
        AD_SERVER, '--db', join(dir, 'corpus.db'), '--port', String(PORT),
        '--transport', 'network', '--threads', '2',
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) { ready = true; break }
      } catch {}
      await Bun.sleep(80)
    }
  })
  afterAll(() => {
    server?.kill('SIGKILL')
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('reachable + /healthz body over the network transport', async () => {
    expect(ready).toBe(true)
    expect(await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).text()).toBe(HEALTH)
  })

  test('/readyz (DB probe) served over the network transport', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/readyz`)
    expect(res.status).toBe(200)
    expect(JSON.parse(await res.text()).db).toBe(true)
  })

  test('/search (DB-backed, storage offload) served over the network transport', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/search?q=view`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
  })

  test('graceful SIGTERM over the network transport (exit 0)', async () => {
    server.kill('SIGTERM')
    const code = await Promise.race([server.exited, Bun.sleep(15000).then(() => 'timeout')])
    expect(code).toBe(0)
  })
})

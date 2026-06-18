// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * Graceful lifecycle (RFC 0007 F2). ad-server traps SIGTERM/SIGINT (hand-rolled — no
 * swift-service-lifecycle), stops accepting (closes the listening channels so in-flight
 * requests drain, bounded by a deadline), flips `/readyz` to 503, then shuts the event-loop
 * group + offload pool down and exits 0 — instead of being hard-killed (143) with no handler.
 *
 * Capability test (no JS equivalent). Skipped when the release binary is absent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../../../src/storage/database.js'

const AD_SERVER = new URL('../../../swift/.build/release/ad-server', import.meta.url).pathname
const PORT = 3061

describe.skipIf(!existsSync(AD_SERVER))('graceful lifecycle (SIGTERM → drain → exit 0)', () => {
  let dir
  let server
  let ready = false

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'f2-'))
    new DocsDatabase(join(dir, 'corpus.db')).close()
    server = Bun.spawn([AD_SERVER, '--db', join(dir, 'corpus.db'), '--port', String(PORT), '--threads', '2'], { stdout: 'ignore', stderr: 'ignore' })
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/readyz`)).ok) {
          ready = true
          break
        }
      } catch {}
      await Bun.sleep(80)
    }
  })
  afterAll(() => {
    server?.kill('SIGKILL')
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('readyz reports ready (200) while serving', async () => {
    expect(ready).toBe(true)
    const res = await fetch(`http://127.0.0.1:${PORT}/readyz`)
    expect(res.status).toBe(200)
  })

  test('SIGTERM drains and exits 0 (not signal-killed)', async () => {
    server.kill('SIGTERM')
    const code = await Promise.race([server.exited, Bun.sleep(15000).then(() => 'timeout')])
    expect(code).toBe(0)
  })
})

// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * Live delegation smoke for the RFC 0005 Phase E web-serve flip. The EXACT argv
 * `nativeServeArgs()` builds for `apple-docs web serve` must be accepted by the
 * real ad-server and bring up a serving instance — this catches a mapping that
 * drifts away from the binary's ArgumentParser surface (a wrong flag name, or a
 * missing `serve` subcommand token).
 *
 * Complements web-routes-parity (which hardcodes the argv + asserts byte parity)
 * by driving the argv through the SAME mapping cli.js uses, with ad-server as a
 * direct child (clean teardown — no cli.js grandchild process to leak).
 *
 * Skipped when the release binary is absent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeServeArgs } from '../../../src/native/ad-server.js'
import { DocsDatabase } from '../../../src/storage/database.js'

const AD_SERVER = new URL('../../../swift/.build/release/ad-server', import.meta.url).pathname
const PORT = 3049
let dir
let server
let ready = false

// The argv cli.js produces for `apple-docs web serve --port P --base-url U`.
const buildArgs = (dbPath) =>
  nativeServeArgs({ command: 'web', subcommand: 'serve', flags: { port: String(PORT), 'base-url': 'https://example.test' }, dbPath })

if (existsSync(AD_SERVER)) {
  dir = mkdtempSync(join(tmpdir(), 'serve-flip-live-'))
  // cli.js opens join(dataDir, 'apple-docs.db'); seed that exact path shape.
  const dbPath = join(dir, 'apple-docs.db')
  const seed = new DocsDatabase(dbPath)
  seed.upsertRoot('swiftui', 'SwiftUI', 'framework', 'seed')
  seed.upsertDocument({
    key: 'swiftui/view',
    title: 'View',
    framework: 'swiftui',
    sourceType: 'apple-docc',
    role: 'symbol',
    roleHeading: 'Protocol',
    kind: 'protocol',
    language: 'swift',
    abstractText: 'A view.',
    urlDepth: 2,
  })
  seed.close()
  server = Bun.spawn([AD_SERVER, ...buildArgs(dbPath)], { stdout: 'ignore', stderr: 'ignore' })
}

describe.skipIf(!existsSync(AD_SERVER))('web serve flip — real ad-server accepts nativeServeArgs() argv', () => {
  beforeAll(async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) {
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

  test('argv leads with the serve subcommand and maps db/port/app-version/base-url', () => {
    const argv = buildArgs(join(dir, 'apple-docs.db'))
    expect(argv[0]).toBe('serve')
    expect(argv).toContain('--db')
    expect(argv).toContain('--port')
    expect(argv).toContain('--app-version')
    expect(argv).toContain('--base-url')
  })

  test('the mapped argv brings up a live server (/healthz ok)', () => {
    expect(ready).toBe(true)
  })

  test('GET /readyz — 200 ready', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/readyz`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})

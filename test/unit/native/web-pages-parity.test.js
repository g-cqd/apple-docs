// Live HTML-page serving parity: ad-server's on-demand landing pages must be
// byte-identical to what `ad-cli web build` writes to disk for the same corpus.
// The static build is already DOM-identical to the Bun build (the chrome-headless
// gate, scripts/web-parity-headless.mjs — 44/44), so `served == built` transitively
// proves `ad-server serve == bun serve` for these shells, without re-deriving the
// JS siteConfig (the build and the server both stamp today's buildDate + the same
// snapshot/commit footer provenance, and both omit the asset cache-buster).
//
// Skipped unless the release ad-cli + ad-server binaries and bun are present.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../../', import.meta.url).pathname
const AD_CLI = join(ROOT, 'swift/.build/release/ad-cli')
const AD_SERVER = join(ROOT, 'swift/.build/release/ad-server')
const SEED = join(ROOT, 'scripts/web-parity-seed.mjs')
const PORT = 3053
const SITE = 'Apple Developer Docs'
const AVAILABLE = existsSync(AD_CLI) && existsSync(AD_SERVER)

let dir
let distDir
let server
let ready = false

if (AVAILABLE) {
  dir = mkdtempSync(join(tmpdir(), 'web-pages-parity-'))
  distDir = join(dir, 'dist')
  const dbPath = join(dir, 'apple-docs.db')
  // 1. Seed the synthetic corpus (roots/docs/sections/fonts/symbols).
  const seed = Bun.spawnSync(['bun', SEED, dir, '--fonts'], { stdout: 'ignore', stderr: 'ignore' })
  // 2. Static build — the byte oracle (itself DOM-identical to the Bun build).
  const build = Bun.spawnSync([AD_CLI, 'web', 'build', '--db', dbPath, '--out', distDir, '--site-name', SITE, '--base-url', '', '--app-version', '1.0.0'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  // 3. The live server on the same corpus + flags → same siteConfig → same bytes.
  if (seed.exitCode === 0 && build.exitCode === 0) {
    server = Bun.spawn([AD_SERVER, 'serve', '--db', dbPath, '--port', String(PORT), '--site-name', SITE, '--base-url', '', '--app-version', '1.0.0'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
  }
}

// The served-path → built-file map. Every shell renders the same ADWebBuild
// template the build writes; `/index.html` aliases `/`, and every `/symbols/<name>`
// serves the one symbols shell (the Bun `/^\/symbols\/.+$/` pattern).
const PAGES = [
  { path: '/', file: 'index.html' },
  { path: '/index.html', file: 'index.html' },
  { path: '/search', file: 'search/index.html' },
  { path: '/fonts', file: 'fonts/index.html' },
  { path: '/symbols', file: 'symbols/index.html' },
  { path: '/symbols/star.fill', file: 'symbols/index.html' },
]

describe.skipIf(!AVAILABLE)('web-pages parity (ad-server serve == ad-cli web build)', () => {
  beforeAll(async () => {
    if (!server) return
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
    // SIGKILL, not SIGTERM — teardown must reap unconditionally so a stuck server
    // never squats the port for the next run (the leak chain these suites hit once).
    server?.kill('SIGKILL')
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('the build produced the landing pages + the server came up', () => {
    expect(server).toBeDefined()
    expect(ready).toBe(true)
    for (const { file } of PAGES) expect(existsSync(join(distDir, file))).toBe(true)
  })

  for (const { path, file } of PAGES) {
    test(`GET ${path} — byte-identical to ${file}`, async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`)
      expect(res.status).toBe(200)
      // Non-hashable shell: text/html, no origin ETag / Cache-Control (as Bun).
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(res.headers.get('cache-control')).toBeNull()
      expect(res.headers.get('etag')).toBeNull()
      const served = new Uint8Array(await res.arrayBuffer())
      const built = new Uint8Array(readFileSync(join(distDir, file)))
      expect(served.length).toBe(built.length)
      expect(Buffer.from(served).equals(Buffer.from(built))).toBe(true)
    })
  }
})

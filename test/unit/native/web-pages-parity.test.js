// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
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

// Highlight OFF on BOTH sides: ad-server renders doc code blocks as the
// `<pre><code>` fallback (highlight: nil — the build precomputes shiki and Caddy
// serves those from dist), so the build oracle must skip highlighting too for a
// byte match. The shells carry no code blocks, so this is inert for them.
const ENV = { ...process.env, APPLE_DOCS_NO_HIGHLIGHT: '1' }

if (AVAILABLE) {
  dir = mkdtempSync(join(tmpdir(), 'web-pages-parity-'))
  distDir = join(dir, 'dist')
  const dbPath = join(dir, 'apple-docs.db')
  // 1. Seed the synthetic corpus (roots/docs/sections/fonts/symbols).
  const seed = Bun.spawnSync(['bun', SEED, dir, '--fonts'], { stdout: 'ignore', stderr: 'ignore' })
  // 2. FULL static build (renders /docs/* + framework pages) — the byte oracle,
  //    itself DOM-identical to the Bun build.
  const build = Bun.spawnSync([AD_CLI, 'web', 'build', '--db', dbPath, '--out', distDir, '--site-name', SITE, '--base-url', '', '--app-version', '1.0.0'], {
    stdout: 'ignore',
    stderr: 'ignore',
    env: ENV,
  })
  // 3. The live server on the same corpus + flags → same siteConfig → same bytes.
  //    --web-root (src/web) serves raw non-JS /assets + verbatim /worker; --web-dist
  //    (the build output) serves the pre-built /assets/*.js bundles.
  if (seed.exitCode === 0 && build.exitCode === 0) {
    server = Bun.spawn(
      [
        AD_SERVER,
        'serve',
        '--db',
        dbPath,
        '--port',
        String(PORT),
        '--site-name',
        SITE,
        '--base-url',
        '',
        '--app-version',
        '1.0.0',
        '--web-root',
        join(ROOT, 'src/web'),
        '--web-dist',
        distDir,
      ],
      {
        stdout: 'ignore',
        stderr: 'ignore',
        env: ENV,
      },
    )
  }
}

// The static-asset map. Non-JS /assets is served RAW from src/web (Bun serve does
// NOT minify at serve time); /assets/*.js is the pre-built bundle from the dist
// (byte-identical to Bun serve's on-the-fly bundle); /worker/* is verbatim from
// src/web. Each entry: served path → the on-disk file it must byte-match.
const SRC_WEB = join(ROOT, 'src/web')
const ASSETS = [
  { path: '/assets/style.css', file: join(SRC_WEB, 'assets/style.css'), ct: 'text/css; charset=utf-8' },
  { path: '/assets/core.js', file: null, ct: 'text/javascript; charset=utf-8' }, // dist bundle (distDir set below)
  { path: '/assets/listing.js', file: null, ct: 'text/javascript; charset=utf-8' },
  { path: '/assets/search-page.js', file: null, ct: 'text/javascript; charset=utf-8' },
  { path: '/worker/search-worker.js', file: join(SRC_WEB, 'worker/search-worker.js'), ct: 'text/javascript; charset=utf-8' },
]

// Non-hashable shells (Bun `pages.route.js`): text/html, no ETag / Cache-Control.
// `/index.html` aliases `/`; every `/symbols/<name>` serves the one symbols shell.
const SHELL_PAGES = [
  { path: '/', file: 'index.html' },
  { path: '/index.html', file: 'index.html' },
  { path: '/search', file: 'search/index.html' },
  { path: '/fonts', file: 'fonts/index.html' },
  { path: '/symbols', file: 'symbols/index.html' },
  { path: '/symbols/star.fill', file: 'symbols/index.html' },
]

// Hashable /docs pages (Bun `HTML_HASHABLE`): text/html + a content-hash ETag,
// no Cache-Control. Document pages (DocPage) + framework listing pages
// (FrameworkPage). `/docs/<key>/index.html` aliases `/docs/<key>`.
const DOC_PAGES = [
  { path: '/docs/swiftui/view', file: 'docs/swiftui/view/index.html' },
  { path: '/docs/swiftui/view/index.html', file: 'docs/swiftui/view/index.html' },
  { path: '/docs/swiftui/state', file: 'docs/swiftui/state/index.html' },
  { path: '/docs/foundation/urlsession', file: 'docs/foundation/urlsession/index.html' },
  { path: '/docs/swiftui', file: 'docs/swiftui/index.html' },
  { path: '/docs/foundation', file: 'docs/foundation/index.html' },
]

const PAGES = [...SHELL_PAGES, ...DOC_PAGES]

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

  test('the build produced the landing + doc pages and the server came up', () => {
    expect(server).toBeDefined()
    expect(ready).toBe(true)
    for (const { file } of PAGES) expect(existsSync(join(distDir, file))).toBe(true)
  })

  const assertByteIdentical = async (path, file) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const served = new Uint8Array(await res.arrayBuffer())
    const built = new Uint8Array(readFileSync(join(distDir, file)))
    expect(served.length).toBe(built.length)
    expect(Buffer.from(served).equals(Buffer.from(built))).toBe(true)
    return res
  }

  for (const { path, file } of SHELL_PAGES) {
    test(`GET ${path} — byte-identical shell, non-hashable`, async () => {
      const res = await assertByteIdentical(path, file)
      // Non-hashable shell: no origin ETag / Cache-Control (as Bun).
      expect(res.headers.get('cache-control')).toBeNull()
      expect(res.headers.get('etag')).toBeNull()
    })
  }

  for (const { path, file } of DOC_PAGES) {
    test(`GET ${path} — byte-identical doc page, hashable`, async () => {
      const res = await assertByteIdentical(path, file)
      // Hashable (Bun HTML_HASHABLE): a sha256[:16] content-hash ETag, no
      // Cache-Control (only the .md variant carries max-age).
      expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{16}"$/)
      expect(res.headers.get('cache-control')).toBeNull()
    })
  }

  // The `/docs/<key>.md` variant: the body is the same rendered Markdown
  // `ad-cli read <key>` prints (cli-parity-gated against Bun's lookup), modulo the
  // CLI's single trailing newline. Headers: text/markdown, the token estimate, the
  // day-long cache, and a content-hash ETag (Bun's markdownResponse).
  const MD_KEYS = ['swiftui/view', 'foundation/urlsession']
  for (const key of MD_KEYS) {
    test(`GET /docs/${key}.md — Markdown == ad-cli read`, async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/docs/${key}.md`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400, stale-while-revalidate=604800')
      expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{16}"$/)
      const served = await res.text()
      // x-markdown-tokens = ceil(UTF-16 length / 4).
      expect(res.headers.get('x-markdown-tokens')).toBe(String(Math.ceil(served.length / 4)))
      const cli = Bun.spawnSync([AD_CLI, 'read', key, '--db', join(dir, 'apple-docs.db')], { env: ENV })
      const expected = cli.stdout.toString()
      expect(served.trimEnd()).toBe(expected.trimEnd())
      expect(served.length).toBeGreaterThan(0)
    })
  }

  // /assets/* + /worker/* — non-JS raw from src/web, JS from the dist bundle,
  // workers verbatim; immutable cache. Byte-match the on-disk source/build file.
  for (const { path, file, ct } of ASSETS) {
    test(`GET ${path} — byte-identical, immutable`, async () => {
      // .js entries resolve to the dist bundle; others to their src/web file.
      const onDisk = file ?? join(distDir, 'assets', path.slice('/assets/'.length))
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe(ct)
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      const served = new Uint8Array(await res.arrayBuffer())
      const built = new Uint8Array(readFileSync(onDisk))
      expect(served.length).toBe(built.length)
      expect(Buffer.from(served).equals(Buffer.from(built))).toBe(true)
    })
  }

  test('asset guards: traversal → 403/404, missing → 404', async () => {
    // A literal `..` segment in the (encoded) path is rejected before any file read.
    expect((await fetch(`http://127.0.0.1:${PORT}/assets/..%2fsecret`)).status).toBeGreaterThanOrEqual(400)
    expect((await fetch(`http://127.0.0.1:${PORT}/assets/does-not-exist.css`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${PORT}/worker/nope.js`)).status).toBe(404)
  })
})

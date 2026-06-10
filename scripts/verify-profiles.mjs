#!/usr/bin/env bun
/**
 * Profile verification harness — installs a published snapshot into an
 * isolated APPLE_DOCS_HOME per storage profile (compact / balanced /
 * prebuilt) and exercises the full user-facing feature set against each:
 *
 *   - CLI: status, frameworks, kinds, search (keyword / filtered / NL /
 *     --read), read (path / symbol / --section), browse, storage.
 *   - Web server: HTML pages, Markdown content negotiation, JSON APIs,
 *     discovery endpoints (api-catalog, MCP server card, robots, opensearch).
 *   - MCP over stdio: initialize, tools/list, every tool, resources/read.
 *   - MCP over Streamable HTTP: initialize + session + tools/call.
 *   - Profile-specific disk expectations (compact DB shrink, balanced
 *     read-through markdown cache, prebuilt materialized markdown + html).
 *
 * Usage:
 *   bun scripts/verify-profiles.mjs                    # download latest release, all profiles
 *   bun scripts/verify-profiles.mjs --archive <path>   # reuse a local .tar.zst
 *   bun scripts/verify-profiles.mjs --profiles compact,balanced
 *   bun scripts/verify-profiles.mjs --keep             # keep installs for debugging
 *
 * The base dir lives under $HOME (setup --archive refuses paths outside it).
 * Each profile is torn down after its checks unless --keep is passed.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ROOT = join(import.meta.dir, '..')
const CLI = join(ROOT, 'cli.js')
const REPO = 'g-cqd/apple-docs'
const WEB_PORT = 43180
const MCP_PORT = 43181

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++ }
    else out[key] = true
  }
  return out
}

const args = parseArgs(process.argv)
const PROFILES = (typeof args.profiles === 'string' ? args.profiles.split(',') : ['compact', 'balanced', 'prebuilt'])
  .map(s => s.trim()).filter(Boolean)
const BASE = args.base ? String(args.base) : join(homedir(), '.apple-docs-profile-verify')
const OUT = args.out ? String(args.out) : join(ROOT, 'reports', 'profile-verify')
const KEEP = !!args.keep
const MIN_FREE_GB = Number(args['min-free-gb'] ?? 15)

mkdirSync(BASE, { recursive: true })
mkdirSync(OUT, { recursive: true })
const LOG = join(OUT, 'verify.log')

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  appendFileSync(LOG, line + '\n')
}

function freeGB(path) {
  const r = Bun.spawnSync(['df', '-k', '-P', path])
  const cols = new TextDecoder().decode(r.stdout).trim().split('\n').at(-1).split(/\s+/)
  return Math.round(Number(cols[3]) / 1024 / 1024)
}

function sha256(path) {
  const r = Bun.spawnSync(['shasum', '-a', '256', path])
  return new TextDecoder().decode(r.stdout).trim().split(/\s+/)[0]
}

/** Download (resumable) + sha256-verify the latest published snapshot. */
async function ensureArchive() {
  if (args.archive) {
    const p = String(args.archive)
    if (!existsSync(p)) throw new Error(`--archive not found: ${p}`)
    return p
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'user-agent': 'apple-docs-verify-profiles' },
  })
  if (!res.ok) throw new Error(`releases/latest -> ${res.status}`)
  const release = await res.json()
  const asset = release.assets.find(a => /^apple-docs-full-.*\.tar\.zst$/.test(a.name))
  const sidecar = release.assets.find(a => a.name === `${asset?.name}.sha256`)
  if (!asset) throw new Error(`no snapshot asset on release ${release.tag_name}`)
  const dest = join(BASE, asset.name)
  log(`latest release: ${release.tag_name}; archive ${asset.name} (${(asset.size / 1e9).toFixed(2)} GB)`)

  let expected = null
  if (sidecar) {
    const t = await (await fetch(sidecar.browser_download_url)).text()
    expected = t.trim().split(/\s+/)[0]
  }
  if (existsSync(dest) && statSync(dest).size === asset.size && (!expected || sha256(dest) === expected)) {
    log(`archive already downloaded and verified: ${dest}`)
    return dest
  }
  log(`downloading ${asset.browser_download_url} -> ${dest}`)
  const curl = Bun.spawn(['curl', '-L', '--retry', '3', '-C', '-', '-o', dest, asset.browser_download_url], {
    stdout: 'inherit', stderr: 'inherit',
  })
  if ((await curl.exited) !== 0) throw new Error('archive download failed')
  if (expected) {
    const got = sha256(dest)
    if (got !== expected) throw new Error(`sha256 mismatch: ${got} != ${expected}`)
    log('sha256 verified')
  }
  return dest
}

/** Run cli.js against a home; tolerant JSON extraction from stdout. */
async function cli(homeDir, cmdArgs, { timeoutMs = 120000 } = {}) {
  const proc = Bun.spawn(['bun', CLI, ...cmdArgs], {
    cwd: ROOT,
    env: { ...process.env, APPLE_DOCS_HOME: homeDir },
    stdout: 'pipe', stderr: 'pipe',
  })
  const timer = timeoutMs > 0 ? setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs) : null
  const code = await proc.exited
  if (timer) clearTimeout(timer)
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  let json
  try { json = JSON.parse(stdout) } catch {
    const i = stdout.indexOf('{')
    if (i >= 0) { try { json = JSON.parse(stdout.slice(i)) } catch {} }
  }
  return { code, stdout, stderr, json }
}

async function probe(checks, name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    checks.push({ name, ok: true, ms: Date.now() - started, detail: detail ?? '' })
    log(`    ✓ ${name}${detail ? ` — ${detail}` : ''} (${Date.now() - started}ms)`)
  } catch (err) {
    checks.push({ name, ok: false, ms: Date.now() - started, detail: err.message })
    log(`    ✗ ${name} — ${err.message}`)
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }

// list_apple_fonts payload: { families: [{ id, files: [{ id, file_name }] }] }.
// render_font_text wants a FILE id, not the family id.
function pickFontFileId(payload) {
  return payload?.families?.[0]?.files?.[0]?.id ?? null
}

/** Spawn a long-running server subcommand; resolve once `readyUrl` answers. */
async function spawnServer(homeDir, cmdArgs, readyUrl, { timeoutMs = 60000 } = {}) {
  const proc = Bun.spawn(['bun', CLI, ...cmdArgs], {
    cwd: ROOT,
    env: { ...process.env, APPLE_DOCS_HOME: homeDir },
    stdout: 'pipe', stderr: 'pipe',
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const err = await new Response(proc.stderr).text()
      throw new Error(`server exited early (${proc.exitCode}): ${err.slice(-300)}`)
    }
    try {
      const r = await fetch(readyUrl, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return proc
    } catch {}
    await Bun.sleep(500)
  }
  try { proc.kill() } catch {}
  throw new Error(`server not ready within ${timeoutMs}ms: ${readyUrl}`)
}

async function stopServer(proc) {
  if (!proc) return
  try { proc.kill('SIGTERM') } catch {}
  const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 10000)
  await proc.exited
  clearTimeout(t)
}

/** Minimal newline-delimited JSON-RPC client over `mcp start` stdio. */
class McpStdio {
  constructor(homeDir) {
    this.proc = Bun.spawn(['bun', CLI, 'mcp', 'start'], {
      cwd: ROOT,
      env: { ...process.env, APPLE_DOCS_HOME: homeDir },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    this.buf = ''
    this.pending = new Map()
    this.nextId = 1
    this.reader = this.proc.stdout.getReader()
    this.readLoop()
  }

  async readLoop() {
    const dec = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await this.reader.read()
        if (done) break
        this.buf += dec.decode(value, { stream: true })
        let nl
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl).trim()
          this.buf = this.buf.slice(nl + 1)
          if (!line) continue
          let msg
          try { msg = JSON.parse(line) } catch { continue }
          const waiter = this.pending.get(msg.id)
          if (waiter) { this.pending.delete(msg.id); waiter(msg) }
        }
      }
    } catch {}
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n')
  }

  request(method, params, { timeoutMs = 60000 } = {}) {
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        if (msg.error) reject(new Error(`MCP ${method} error: ${msg.error.message ?? JSON.stringify(msg.error)}`))
        else resolve(msg.result)
      })
      this.proc.stdin.write(payload + '\n')
    })
  }

  async close() {
    try { this.proc.stdin.end() } catch {}
    await stopServer(this.proc)
  }
}

/** Parse a Streamable HTTP response body (JSON or SSE) into the JSON-RPC message. */
async function parseStreamable(res) {
  const ct = res.headers.get('content-type') ?? ''
  const text = await res.text()
  if (ct.includes('text/event-stream')) {
    const events = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
    for (const data of events.reverse()) {
      try { return JSON.parse(data) } catch {}
    }
    throw new Error('no parseable SSE data event')
  }
  if (!text) return null
  return JSON.parse(text)
}

async function mcpHttpCall(url, session, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(body),
  })
  assert(res.ok || res.status === 202, `POST /mcp -> ${res.status}`)
  return { session: res.headers.get('mcp-session-id') ?? session, message: res.status === 202 ? null : await parseStreamable(res) }
}

function toolPayload(result) {
  if (result?.structuredContent) return result.structuredContent
  const text = result?.content?.find(c => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

const TOOL_NAMES = [
  'search_docs', 'read_doc', 'list_frameworks', 'browse', 'list_taxonomy',
  'search_sf_symbols', 'list_apple_fonts', 'render_sf_symbol', 'render_font_text',
]

async function runCliChecks(home, profile, checks) {
  await probe(checks, 'cli: status reports full corpus', async () => {
    const r = await cli(home, ['status', '--json'])
    assert(r.code === 0 && r.json, `exit ${r.code}: ${r.stderr.slice(-200)}`)
    const active = r.json.pages?.active ?? 0
    assert(active > 300000, `active=${active}`)
    assert((r.json.roots?.total ?? 0) > 400, `roots=${r.json.roots?.total}`)
    return `${active} pages, ${r.json.roots.total} roots`
  })

  await probe(checks, 'cli: storage profile is applied', async () => {
    const r = await cli(home, ['storage', 'profile', '--json'])
    assert(r.code === 0, `exit ${r.code}`)
    assert(r.stdout.includes(profile), `expected ${profile} in: ${r.stdout.slice(0, 200)}`)
    return profile
  })

  await probe(checks, 'cli: frameworks lists roots', async () => {
    const r = await cli(home, ['frameworks', '--json'])
    assert(r.code === 0 && r.json, `exit ${r.code}`)
    const arr = Array.isArray(r.json) ? r.json : (r.json.frameworks ?? r.json.roots ?? [])
    assert(arr.length > 300, `${arr.length} roots`)
    return `${arr.length} roots`
  })

  await probe(checks, 'cli: kinds taxonomy', async () => {
    const r = await cli(home, ['kinds', '--json'])
    assert(r.code === 0, `exit ${r.code}`)
    return 'ok'
  })

  await probe(checks, 'cli: search exact symbol (NavigationStack)', async () => {
    const r = await cli(home, ['search', 'NavigationStack', '--json'])
    assert(r.code === 0 && r.json, `exit ${r.code}`)
    const hits = r.json.results ?? []
    assert(hits.length > 0, 'zero results')
    assert(JSON.stringify(hits.slice(0, 3)).toLowerCase().includes('navigationstack'), 'top hits miss the symbol')
    return `${hits.length} hits, top=${hits[0].path}`
  })

  await probe(checks, 'cli: search filtered (--source wwdc --year 2024)', async () => {
    const r = await cli(home, ['search', 'Swift Testing', '--source', 'wwdc', '--year', '2024', '--json'])
    assert(r.code === 0 && r.json, `exit ${r.code}`)
    assert((r.json.results ?? []).length > 0, 'zero results')
    return `${r.json.results.length} hits`
  })

  await probe(checks, 'cli: search filtered (--framework app-store-review)', async () => {
    const r = await cli(home, ['search', 'privacy', '--framework', 'app-store-review', '--json'])
    assert(r.code === 0 && r.json, `exit ${r.code}`)
    assert((r.json.results ?? []).length > 0, 'zero results')
    return `${r.json.results.length} hits`
  })

  await probe(checks, 'cli: semantic NL query resolves', async () => {
    const r = await cli(home, ['search', 'how do I record audio in the background', '--json'])
    assert(r.code === 0 && r.json, `exit ${r.code}`)
    assert((r.json.results ?? []).length > 0, 'zero results')
    return `${r.json.results.length} hits`
  })

  await probe(checks, 'cli: search --read returns content', async () => {
    const r = await cli(home, ['search', 'NavigationStack', '--read', '--max-chars', '2000', '--json'])
    assert(r.code === 0 && r.json, `exit ${r.code}`)
    assert(JSON.stringify(r.json).length > 500, 'thin payload')
    return 'ok'
  })

  await probe(checks, 'cli: read by path (swiftui/view)', async () => {
    const r = await cli(home, ['read', 'swiftui/view', '--json'])
    assert(r.code === 0 && r.json, `exit ${r.code}`)
    assert(r.json.found !== false, 'not found')
    assert((r.json.content ?? '').length > 500, `content len=${(r.json.content ?? '').length}`)
    return `${r.json.content.length} chars`
  })

  await probe(checks, 'cli: read by symbol (View --framework swiftui)', async () => {
    const r = await cli(home, ['read', 'View', '--framework', 'swiftui', '--json'])
    assert(r.code === 0 && r.json && r.json.found !== false, `exit ${r.code}`)
    return 'ok'
  })

  await probe(checks, 'cli: read --section Overview', async () => {
    const r = await cli(home, ['read', 'swiftui/view', '--section', 'Overview', '--json'])
    assert(r.code === 0 && r.json && r.json.found !== false, `exit ${r.code}`)
    return 'ok'
  })

  await probe(checks, 'cli: browse framework + drill-down', async () => {
    const r = await cli(home, ['browse', 'swiftui', '--limit', '20', '--json'])
    assert(r.code === 0 && r.json, `exit ${r.code}`)
    const r2 = await cli(home, ['browse', 'swiftui', '--path', 'swiftui/view', '--json'])
    assert(r2.code === 0 && r2.json, `drill exit ${r2.code}`)
    return 'ok'
  })

  await probe(checks, 'cli: storage stats breakdown', async () => {
    const r = await cli(home, ['storage', 'stats', '--json'])
    assert(r.code === 0 && r.json, `exit ${r.code}`)
    return `total=${r.json.total}`
  })
}

async function runWebChecks(home, checks) {
  let proc
  await probe(checks, 'web: server starts and reports healthy', async () => {
    proc = await spawnServer(home, ['web', 'serve', '--port', String(WEB_PORT)], `http://127.0.0.1:${WEB_PORT}/healthz`)
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/readyz`)
    assert(r.ok, `/readyz -> ${r.status}`)
    return 'healthy + ready'
  })
  if (!proc) return

  const base = `http://127.0.0.1:${WEB_PORT}`
  try {
    await probe(checks, 'web: doc page renders as HTML', async () => {
      const r = await fetch(`${base}/docs/swiftui/view`)
      assert(r.ok, `-> ${r.status}`)
      const body = await r.text()
      assert(body.includes('<html') || body.includes('<!DOCTYPE'), 'not HTML')
      return `${body.length} bytes`
    })

    await probe(checks, 'web: markdown via .md suffix', async () => {
      // Markdown is exposed as /docs/<key>.md (a path keeps CDN cache keys
      // clean — no Vary: Accept), not via Accept-header negotiation.
      const r = await fetch(`${base}/docs/swiftui/view.md`)
      assert(r.ok, `-> ${r.status}`)
      const ct = r.headers.get('content-type') ?? ''
      const body = await r.text()
      assert(ct.includes('markdown'), `ct=${ct}`)
      assert(body.length > 500, `len=${body.length}`)
      return `${body.length} bytes, tokens≈${r.headers.get('x-markdown-tokens')}`
    })

    await probe(checks, 'web: /api/search returns hits', async () => {
      const r = await fetch(`${base}/api/search?q=NavigationStack`)
      assert(r.ok, `-> ${r.status}`)
      const j = await r.json()
      const hits = j.results ?? j.hits ?? []
      assert(hits.length > 0, 'zero results')
      return `${hits.length} hits`
    })

    await probe(checks, 'web: symbols + fonts APIs', async () => {
      const s = await fetch(`${base}/api/symbols/search?q=pencil`)
      assert(s.ok, `symbols -> ${s.status}`)
      const f = await fetch(`${base}/api/fonts`)
      assert(f.ok, `fonts -> ${f.status}`)
      return 'ok'
    })

    await probe(checks, 'web: discovery endpoints', async () => {
      for (const p of ['/.well-known/api-catalog', '/.well-known/mcp/server-card.json', '/robots.txt', '/opensearch.xml']) {
        const r = await fetch(`${base}${p}`)
        assert(r.ok, `${p} -> ${r.status}`)
      }
      return '4 endpoints'
    })
  } finally {
    await stopServer(proc)
  }
}

async function runMcpStdioChecks(home, checks, report) {
  const client = new McpStdio(home)
  try {
    await probe(checks, 'mcp(stdio): initialize handshake', async () => {
      const r = await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'verify-profiles', version: '0.0.0' },
      })
      assert(r?.serverInfo?.name === 'apple-docs', `serverInfo=${JSON.stringify(r?.serverInfo)}`)
      client.notify('notifications/initialized')
      return `protocol ${r.protocolVersion}`
    })

    await probe(checks, 'mcp(stdio): tools/list exposes the full surface', async () => {
      const r = await client.request('tools/list')
      const names = (r.tools ?? []).map(t => t.name).sort()
      assert(JSON.stringify(names) === JSON.stringify([...TOOL_NAMES].sort()), `got ${names.join(',')}`)
      const bytes = JSON.stringify(r.tools).length
      report.toolsListBytes = bytes
      return `${names.length} tools, definitions ${(bytes / 1024).toFixed(1)} KiB (~${Math.round(bytes / 4)} tokens)`
    })

    const call = (name, argsObj) => client.request('tools/call', { name, arguments: argsObj })

    await probe(checks, 'mcp(stdio): search_docs', async () => {
      const p = toolPayload(await call('search_docs', { query: 'NavigationStack', limit: 3 }))
      assert((p?.results ?? []).length > 0, 'zero results')
      return `${p.results.length} hits`
    })

    await probe(checks, 'mcp(stdio): read_doc paginated', async () => {
      const p = toolPayload(await call('read_doc', { path: 'swiftui/view', maxChars: 5000 }))
      assert(p?.found !== false, 'not found')
      return 'ok'
    })

    await probe(checks, 'mcp(stdio): list_frameworks', async () => {
      const p = toolPayload(await call('list_frameworks', {}))
      const roots = p?.roots ?? p?.frameworks ?? []
      assert(roots.length > 300, `${roots.length} roots`)
      return `${roots.length} roots`
    })

    await probe(checks, 'mcp(stdio): browse', async () => {
      const p = toolPayload(await call('browse', { framework: 'swiftui', limit: 5 }))
      assert(p != null, 'empty payload')
      return 'ok'
    })

    await probe(checks, 'mcp(stdio): list_taxonomy', async () => {
      const p = toolPayload(await call('list_taxonomy', {}))
      assert(p != null, 'empty payload')
      return 'ok'
    })

    await probe(checks, 'mcp(stdio): search_sf_symbols', async () => {
      const p = toolPayload(await call('search_sf_symbols', { query: 'pencil', limit: 5 }))
      assert(JSON.stringify(p).includes('pencil'), 'no pencil symbols')
      return 'ok'
    })

    let fontId = null
    await probe(checks, 'mcp(stdio): list_apple_fonts', async () => {
      const p = toolPayload(await call('list_apple_fonts', {}))
      fontId = pickFontFileId(p)
      assert(fontId, 'no font file id found in payload')
      return `fontId=${fontId}`
    })

    await probe(checks, 'mcp(stdio): render_sf_symbol (svg)', async () => {
      const p = toolPayload(await call('render_sf_symbol', { name: 'pencil', format: 'svg', size: 64 }))
      assert((p?.svg ?? '').includes('<svg'), 'no inline svg')
      return `${p.svg.length} bytes`
    })

    await probe(checks, 'mcp(stdio): render_font_text', async () => {
      assert(fontId, 'no fontId from list_apple_fonts')
      const p = toolPayload(await call('render_font_text', { fontId, text: 'Hello', size: 24 }))
      assert(JSON.stringify(p).includes('<svg') || JSON.stringify(p).includes('svg'), 'no svg markup')
      return 'ok'
    })

    await probe(checks, 'mcp(stdio): resources/read doc + framework', async () => {
      const d = await client.request('resources/read', { uri: 'apple-docs://doc/swiftui/view' })
      assert((d?.contents ?? []).length > 0, 'empty doc resource')
      const f = await client.request('resources/read', { uri: 'apple-docs://framework/swiftui' })
      assert((f?.contents ?? []).length > 0, 'empty framework resource')
      return 'ok'
    })
  } finally {
    await client.close()
  }
}

async function runMcpHttpChecks(home, checks) {
  let proc
  await probe(checks, 'mcp(http): server starts and reports healthy', async () => {
    proc = await spawnServer(home, ['mcp', 'serve', '--port', String(MCP_PORT)], `http://127.0.0.1:${MCP_PORT}/healthz`)
    return 'healthy'
  })
  if (!proc) return

  const url = `http://127.0.0.1:${MCP_PORT}/mcp`
  try {
    let session = null
    await probe(checks, 'mcp(http): initialize (stateless)', async () => {
      const r = await mcpHttpCall(url, null, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-profiles', version: '0.0.0' } },
      })
      assert(r.message?.result?.serverInfo?.name === 'apple-docs', 'bad initialize result')
      // The server runs the SDK's stateless Streamable HTTP transport
      // (sessionIdGenerator: undefined) — no mcp-session-id is expected;
      // every request is self-contained.
      session = r.session
      return session ? `session ${session.slice(0, 8)}…` : 'stateless (no session header)'
    })

    await probe(checks, 'mcp(http): tools/call search_docs', async () => {
      const r = await mcpHttpCall(url, session, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'search_docs', arguments: { query: 'NavigationStack', limit: 3 } },
      })
      const p = toolPayload(r.message?.result)
      assert((p?.results ?? []).length > 0, 'zero results')
      return `${p.results.length} hits`
    })
  } finally {
    await stopServer(proc)
  }
}

async function runProfileExpectations(home, profile, checks) {
  const r = await cli(home, ['storage', 'stats', '--json'])
  const stats = r.json ?? {}
  const db = stats.database?.size ?? 0
  const mdFiles = stats.markdown?.files ?? 0
  const htmlFiles = stats.html?.files ?? 0

  if (profile === 'compact') {
    await probe(checks, 'profile(compact): DB shrank below 3.5 GB', async () => {
      assert(Number(db) > 0 && Number(db) < 3.5e9, `db=${db}`)
      return `db=${(db / 1e9).toFixed(2)} GB`
    })
  }
  if (profile === 'balanced') {
    await probe(checks, 'profile(balanced): markdown cached on first read', async () => {
      assert(mdFiles > 0, `markdown files=${mdFiles} (reads above should have populated the cache)`)
      return `${mdFiles} cached files`
    })
  }
  if (profile === 'prebuilt') {
    await probe(checks, 'profile(prebuilt): markdown + html materialized', async () => {
      assert(mdFiles > 300000, `markdown files=${mdFiles}`)
      assert(htmlFiles > 300000, `html files=${htmlFiles}`)
      return `${mdFiles} md + ${htmlFiles} html files`
    })
  }
}

async function runProfile(profile, archive) {
  const home = join(BASE, profile)
  const report = { profile, checks: [], setupMs: 0 }
  log(`\n=== PROFILE: ${profile} ===`)
  const free = freeGB(BASE)
  log(`  free disk: ${free} GB`)
  if (free < MIN_FREE_GB) throw new Error(`insufficient disk: ${free} GB < ${MIN_FREE_GB} GB`)

  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })

  const t0 = Date.now()
  await probe(report.checks, `setup --archive --profile ${profile}`, async () => {
    const r = await cli(home, ['setup', '--archive', archive, '--profile', profile, '--yes'], { timeoutMs: 45 * 60 * 1000 })
    assert(r.code === 0, `exit ${r.code}: ${r.stderr.slice(-400)}`)
    return `${Math.round((Date.now() - t0) / 1000)}s`
  })
  report.setupMs = Date.now() - t0

  const setupOk = report.checks[0]?.ok
  if (setupOk) {
    await runCliChecks(home, profile, report.checks)
    await runProfileExpectations(home, profile, report.checks)
    await runWebChecks(home, report.checks)
    await runMcpStdioChecks(home, report.checks, report)
    await runMcpHttpChecks(home, report.checks)
  }

  if (!KEEP) {
    rmSync(home, { recursive: true, force: true })
    log(`  torn down ${home}`)
  }

  report.passed = report.checks.filter(c => c.ok).length
  report.failed = report.checks.filter(c => !c.ok).length
  return report
}

const archive = await ensureArchive()
const results = []
log(`verify-profiles: profiles=[${PROFILES.join(', ')}] base=${BASE} archive=${archive}`)
for (const profile of PROFILES) {
  try {
    results.push(await runProfile(profile, archive))
  } catch (err) {
    log(`!! PROFILE ${profile} aborted: ${err.message}`)
    results.push({ profile, checks: [], passed: 0, failed: 1, error: err.message })
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ archive, base: BASE, results }, null, 2))
}

let md = `# Storage-profile verification\n\nArchive: \`${archive}\`\n\n`
for (const r of results) {
  md += `## ${r.profile} — ${r.failed === 0 && !r.error ? 'PASS' : 'FAIL'} (${r.passed}✓ / ${r.failed}✗, setup ${(r.setupMs / 1000 || 0).toFixed(0)}s)\n\n`
  if (r.error) md += `> aborted: ${r.error}\n\n`
  for (const c of r.checks) md += `- ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}\n`
  if (r.toolsListBytes) md += `\ntools/list definitions: ${(r.toolsListBytes / 1024).toFixed(1)} KiB (~${Math.round(r.toolsListBytes / 4)} tokens)\n`
  md += '\n'
}
writeFileSync(join(OUT, 'report.md'), md)
log(`\nDONE. Report: ${join(OUT, 'report.md')}`)
console.log('\n' + md)
process.exit(results.some(r => r.failed > 0 || r.error) ? 1 : 0)

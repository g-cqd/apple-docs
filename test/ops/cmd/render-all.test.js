/**
 * Tests for ops/cmd/render-all.js. Fully in-memory: the fake `fs`
 * captures every write so we can assert filenames + content without
 * touching the disk.
 */

import { describe, test, expect } from 'bun:test'
import runRenderAll, { resolveOutput, findTemplates } from '../../../ops/cmd/render-all.js'

const OPS = '/fake/ops'

function fakeEnv(extra = {}) {
  const vars = {
    USER_NAME: 'gc', REPO_DIR: '/r', OPS_DIR: OPS, DATA_DIR: '/d', BUN_BIN: '/b',
    LABEL_PREFIX: 'mt.test',
    LABEL_PROXY: 'mt.test.proxy', LABEL_WEB: 'mt.test.web', LABEL_MCP: 'mt.test.mcp',
    LABEL_TUNNEL_WEB: 'mt.test.cloudflared.web', LABEL_TUNNEL_MCP: 'mt.test.cloudflared.mcp',
    LABEL_WATCHDOG: 'mt.test.watchdog',
    STATIC_DIR: '/r/dist/web',
    WEB_PORT: '443', MCP_PORT: '443', WEB_BACKEND_PORT: '3130', MCP_BACKEND_PORT: '3131',
    PUBLIC_WEB_HOST: 'apple-docs.example', PUBLIC_MCP_HOST: 'apple-docs-mcp.example',
    CADDY_ADMIN_ADDR: 'unix//tmp/caddy.sock',
    TUNNEL_NAME_WEB: 'apple-docs', TUNNEL_NAME_MCP: 'apple-docs-mcp',
    CLOUDFLARED_CREDENTIALS_FILE_WEB: '/x.json', CLOUDFLARED_CREDENTIALS_FILE_MCP: '/y.json',
    CLOUDFLARED_BIN: '/usr/bin/cloudflared',
    APPLE_DOCS_MCP_CACHE_SCALE: '1',
    ...extra,
  }
  return {
    vars, opsDir: OPS, repoDir: '/r', dataDir: '/d', bunBin: '/b', staticDir: '/r/dist/web',
    labels: {},
  }
}

function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const dirs = new Map()  // path -> [{name, isDirectory(), isFile()}]
  function addEntry(parent, name, kind) {
    if (!dirs.has(parent)) dirs.set(parent, [])
    const list = dirs.get(parent)
    if (!list.find(e => e.name === name)) {
      list.push({
        name,
        isDirectory: () => kind === 'dir',
        isFile: () => kind === 'file',
      })
    }
  }
  // build dir tree from files
  for (const path of files.keys()) {
    const parts = path.split('/').filter(Boolean)
    let cur = ''
    for (let i = 0; i < parts.length - 1; i++) {
      const parent = '/' + parts.slice(0, i).join('/')
      addEntry(parent === '/' ? '/' : parent, parts[i], 'dir')
      cur = '/' + parts.slice(0, i + 1).join('/')
    }
    const parentDir = '/' + parts.slice(0, -1).join('/')
    addEntry(parentDir === '/' ? '/' : parentDir, parts[parts.length - 1], 'file')
    void cur
  }
  return {
    readdir: (d) => dirs.get(d) ?? [],
    stat: () => ({}),
    readFile: (p) => files.get(p) ?? '',
    tryReadFile: (p) => files.has(p) ? files.get(p) : null,
    write: (p, content) => files.set(p, content),
    files,
  }
}

const captureLogger = () => {
  const chunks = []
  return {
    chunks,
    say: (m) => chunks.push({ kind: 'say', m }),
    warn: (m) => chunks.push({ kind: 'warn', m }),
    error: (m) => chunks.push({ kind: 'error', m }),
  }
}

describe('resolveOutput', () => {
  test('launchd plist maps to label-prefixed filename', () => {
    const out = resolveOutput(`${OPS}/launchd/apple-docs.web.plist.tpl`, OPS, { LABEL_WEB: 'mt.test.web' })
    expect(out).toBe(`${OPS}/launchd/mt.test.web.plist`)
  })
  test('sudoers template drops the .tpl suffix, no mapping', () => {
    const out = resolveOutput(`${OPS}/launchd/sudoers.apple-docs-launchctl.tpl`, OPS, {})
    expect(out).toBe(`${OPS}/launchd/sudoers.apple-docs-launchctl`)
  })
  test('non-launchd templates simply strip .tpl', () => {
    expect(resolveOutput(`${OPS}/caddy/Caddyfile.tpl`, OPS, {})).toBe(`${OPS}/caddy/Caddyfile`)
    expect(resolveOutput(`${OPS}/cloudflared/config.yml.tpl`, OPS, {})).toBe(`${OPS}/cloudflared/config.yml`)
  })
  test('unknown launchd template falls back to default + warns', () => {
    const log = captureLogger()
    const out = resolveOutput(`${OPS}/launchd/something-new.plist.tpl`, OPS, {}, log)
    expect(out).toBe(`${OPS}/launchd/something-new.plist`)
    expect(log.chunks.some(c => c.kind === 'warn' && c.m.includes('unknown launchd'))).toBe(true)
  })
})

describe('findTemplates', () => {
  test('walks recursively and sorts byte-wise', () => {
    const fs = fakeFs({
      '/r/a/b/c.tpl': 'x',
      '/r/a/d.tpl': 'y',
      '/r/skip.txt': 'z',
      '/r/e.tpl': 'w',
    })
    const out = findTemplates('/r', fs)
    expect(out).toEqual(['/r/a/b/c.tpl', '/r/a/d.tpl', '/r/e.tpl'])
  })
})

describe('runRenderAll', () => {
  test('renders each template and reports counts', async () => {
    const fs = fakeFs({
      [`${OPS}/launchd/apple-docs.web.plist.tpl`]: 'label=${LABEL_WEB}',
      [`${OPS}/caddy/Caddyfile.tpl`]: 'host=${PUBLIC_WEB_HOST}',
    })
    const logger = captureLogger()
    const code = await runRenderAll({
      args: [],
      envLoader: () => fakeEnv(),
      logger,
      fs,
    })
    expect(code).toBe(0)
    expect(fs.files.get(`${OPS}/launchd/mt.test.web.plist`)).toBe('label=mt.test.web')
    expect(fs.files.get(`${OPS}/caddy/Caddyfile`)).toBe('host=apple-docs.example')
    const says = logger.chunks.filter(c => c.kind === 'say').map(c => c.m).join('\n')
    expect(says).toContain('rendered: ')
    expect(says).toContain('2 of 2 templates rendered')
  })

  test('--dry-run does not write but logs each pair', async () => {
    const fs = fakeFs({
      [`${OPS}/caddy/Caddyfile.tpl`]: 'x',
    })
    const logger = captureLogger()
    const code = await runRenderAll({ args: ['--dry-run'], envLoader: () => fakeEnv(), logger, fs })
    expect(code).toBe(0)
    expect(fs.files.get(`${OPS}/caddy/Caddyfile`)).toBeUndefined()
    expect(logger.chunks.some(c => c.m.includes('dry-run'))).toBe(true)
  })

  test('--check returns 1 on drift', async () => {
    const fs = fakeFs({
      [`${OPS}/caddy/Caddyfile.tpl`]: 'host=${PUBLIC_WEB_HOST}',
      [`${OPS}/caddy/Caddyfile`]: 'host=STALE',
    })
    const code = await runRenderAll({ args: ['--check'], envLoader: () => fakeEnv(), logger: captureLogger(), fs })
    expect(code).toBe(1)
  })

  test('--check returns 0 when rendered output matches on-disk content', async () => {
    const fs = fakeFs({
      [`${OPS}/caddy/Caddyfile.tpl`]: 'host=${PUBLIC_WEB_HOST}',
      [`${OPS}/caddy/Caddyfile`]: 'host=apple-docs.example',
    })
    const code = await runRenderAll({ args: ['--check'], envLoader: () => fakeEnv(), logger: captureLogger(), fs })
    expect(code).toBe(0)
  })

  test('warns on unresolved placeholders without failing', async () => {
    const fs = fakeFs({
      [`${OPS}/caddy/Caddyfile.tpl`]: 'host=${PUBLIC_WEB_HOST};missing=${OPS_DIR}',
    })
    const env = fakeEnv()
    delete env.vars.OPS_DIR
    const logger = captureLogger()
    const code = await runRenderAll({ args: [], envLoader: () => env, logger, fs })
    expect(code).toBe(0)
    expect(logger.chunks.some(c => c.kind === 'warn' && c.m.includes('unresolved vars'))).toBe(true)
  })

  test('returns 0 when no templates exist', async () => {
    const fs = fakeFs({})
    const logger = captureLogger()
    const code = await runRenderAll({ args: [], envLoader: () => fakeEnv(), logger, fs })
    expect(code).toBe(0)
    expect(logger.chunks.some(c => c.kind === 'warn' && c.m.includes('no *.tpl'))).toBe(true)
  })
})

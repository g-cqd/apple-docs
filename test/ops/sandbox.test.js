/**
 * Tests for ops/bin/run-sandboxed.sh and ops/sandbox/apple-docs-serve.sb.
 *
 * The wrapper cases run everywhere. The profile cases run the real
 * `sandbox-exec` and so run on macOS only: they prove what the sandbox
 * blocks and allows, not just what the profile text says.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderTemplateString } from '../../ops/lib/render-template.js'

const REPO = join(import.meta.dir, '../..')
const WRAPPER = join(REPO, 'ops/bin/run-sandboxed.sh')
const BUN = process.execPath
const isDarwin = process.platform === 'darwin'

let work // scratch root, removed afterwards
let opsDir
let dataDir

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'apple-docs-sandbox-test-'))
  opsDir = join(work, 'ops')
  dataDir = join(work, 'data')
  mkdirSync(dataDir, { recursive: true })
  cpSync(join(REPO, 'ops/sandbox'), join(opsDir, 'sandbox'), { recursive: true })
})

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

/** Run the wrapper to completion and return { code, stdout, stderr }. */
async function runWrapper(args, env = {}) {
  const proc = Bun.spawn(['/bin/sh', WRAPPER, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: homedir(),
      REPO_DIR: REPO, DATA_DIR: dataDir, OPS_DIR: opsDir, BUN_BIN: BUN,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, stdout, stderr }
}

describe('run-sandboxed.sh argument handling', () => {
  test('SANDBOX_SERVE=off runs the command directly and says so', async () => {
    const r = await runWrapper(['--', '/bin/echo', 'hello', 'world'], { SANDBOX_SERVE: 'off' })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('hello world')
    expect(r.stderr).toContain('unsandboxed')
  })

  test('rejects an unknown option with exit 64', async () => {
    const r = await runWrapper(['--bogus', '--', '/bin/echo'], { SANDBOX_SERVE: 'off' })
    expect(r.code).toBe(64)
  })

  test('rejects a missing command with exit 64', async () => {
    const r = await runWrapper(['--port', '3130', '--'], {})
    expect(r.code).toBe(64)
    expect(r.stderr).toContain('no command')
  })

  test('with the sandbox on, --port is required', async () => {
    const r = await runWrapper(['--', '/bin/echo'], { SANDBOX_SERVE: 'on' })
    expect(r.code).toBe(64)
    expect(r.stderr).toContain('--port')
  })

  test('with the sandbox on, a missing required variable is an error, not a silent unconfined start', async () => {
    const r = await runWrapper(['--port', '3130', '--', '/bin/echo'], { SANDBOX_SERVE: 'on', DATA_DIR: '' })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('DATA_DIR')
  })
})

describe('launchd plists use the wrapper', () => {
  const vars = {
    LABEL_WEB: 'mt.test.web', LABEL_MCP: 'mt.test.mcp', USER_NAME: 'gc', REPO_DIR: '/r', OPS_DIR: '/o', DATA_DIR: '/d',
    BUN_BIN: '/b/bun', WEB_BACKEND_PORT: '3130', MCP_BACKEND_PORT: '3131', PUBLIC_WEB_HOST: 'web.example', PUBLIC_MCP_HOST: 'mcp.example',
    APPLE_DOCS_MCP_CACHE_SCALE: '1', SANDBOX_SERVE: 'on',
  }
  const render = (name) => renderTemplateString(readFileSync(join(REPO, `ops/launchd/${name}.plist.tpl`), 'utf8'), vars)
  const programArguments = (xml) => [...xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1])

  test.each([
    ['apple-docs.web', '3130', true],
    ['apple-docs.mcp', '3131', false],
  ])('%s starts through run-sandboxed.sh on port %s (egress: %p)', (name, port, egress) => {
    const r = render(name)
    expect(r.unresolved).toEqual([])
    const args = programArguments(r.content)
    expect(args.slice(0, 3)).toEqual(['/o/bin/run-sandboxed.sh', '--port', port])
    expect(args.includes('--egress')).toBe(egress)
    expect(args[args.indexOf('--') + 1]).toBe('/b/bun')
  })

  test.each(['apple-docs.web', 'apple-docs.mcp'])('%s passes the wrapper its inputs through the environment', (name) => {
    const env = render(name).content
    for (const key of ['SANDBOX_SERVE', 'REPO_DIR', 'OPS_DIR', 'DATA_DIR', 'BUN_BIN']) {
      expect(env).toMatch(new RegExp(`<key>${key}</key>\\s*<string>[^<]+</string>`))
    }
  })

  test('the daemons that must stay unconfined are not wrapped', () => {
    for (const name of ['apple-docs.proxy', 'apple-docs.watchdog', 'apple-docs.autoroll']) {
      expect(readFileSync(join(REPO, `ops/launchd/${name}.plist.tpl`), 'utf8')).not.toContain('run-sandboxed')
    }
  })
})

describe.skipIf(!isDarwin)('Seatbelt profile (macOS, real sandbox-exec)', () => {
  /** Script run under the profile; reports one line per probe. */
  const PROBE = `
    import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
    import { connect } from 'node:net'
    import { homedir } from 'node:os'
    const out = {}
    const t = async (name, fn) => { try { await fn(); out[name] = 'allowed' } catch (e) { out[name] = 'blocked' } }
    const data = process.env.PROBE_DATA
    await t('read home dir', () => readdirSync(homedir()))
    await t('read ~/.ssh', () => readdirSync(homedir() + '/.ssh'))
    await t('write home', () => writeFileSync(homedir() + '/apple-docs-sandbox-probe', 'x'))
    await t('write repo', () => writeFileSync(process.env.PROBE_REPO + '/apple-docs-sandbox-probe', 'x'))
    await t('read repo', () => readFileSync(process.env.PROBE_REPO + '/package.json'))
    await t('write data dir', () => writeFileSync(data + '/probe-ok', 'x'))
    await t('write tmp dir', () => writeFileSync(data + '/tmp/probe-ok', 'x'))
    const spawn = (cmd) => { const p = Bun.spawnSync(cmd); if (p.exitCode !== 0) throw new Error('exit') }
    await t('spawn sh', () => spawn(['/bin/sh', '-c', 'true']))
    await t('spawn git', () => spawn(['git', '--version']))
    await t('spawn python3', () => spawn(['python3', '-V']))
    await t('spawn curl', () => spawn(['/usr/bin/curl', '--version']))
    writeFileSync(data + '/a.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>')
    await t('sips svg to png', () => { spawn(['/usr/bin/sips', '-s', 'format', 'png', data + '/a.svg', '--out', data + '/a.png']); if (Bun.file(data + '/a.png').size === 0) throw new Error('empty') })
    await t('connect to loopback listener', () => new Promise((res, rej) => { const s = connect({ host: '127.0.0.1', port: Number(process.env.PROBE_LISTENER), timeout: 3000 }, () => { s.destroy(); res() }); s.on('error', rej); s.on('timeout', () => rej(new Error('timeout'))) }))
    console.log(JSON.stringify(out))
  `

  let listener
  let probePath
  beforeAll(() => {
    // A loopback listener outside the sandbox: the profile must stop the probe from reaching it.
    listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { open(s) { s.end() }, data() {} } })
    probePath = join(dataDir, 'probe.js')
    writeFileSync(probePath, PROBE)
  })
  afterAll(() => {
    listener?.stop(true)
    rmSync(join(homedir(), 'apple-docs-sandbox-probe'), { force: true })
    rmSync(join(REPO, 'apple-docs-sandbox-probe'), { force: true })
  })

  async function probe(args) {
    const r = await runWrapper([...args, '--', BUN, probePath], {
      SANDBOX_SERVE: 'on', PROBE_DATA: dataDir, PROBE_REPO: REPO, PROBE_LISTENER: String(listener.port),
    })
    expect(r.code).toBe(0)
    return JSON.parse(r.stdout.trim().split('\n').at(-1))
  }

  test('blocks reading the home directory and writing outside the data, log and temp dirs', async () => {
    const result = await probe(['--port', '3999'])
    expect(result).toMatchObject({
      'read home dir': 'blocked',
      'read ~/.ssh': 'blocked',
      'write home': 'blocked',
      'write repo': 'blocked',
    })
    expect(existsSync(join(homedir(), 'apple-docs-sandbox-probe'))).toBe(false)
    expect(existsSync(join(REPO, 'apple-docs-sandbox-probe'))).toBe(false)
  })

  test('still reads the checkout and writes the data and temp dirs', async () => {
    expect(await probe(['--port', '3999'])).toMatchObject({
      'read repo': 'allowed',
      'write data dir': 'allowed',
      'write tmp dir': 'allowed',
    })
  })

  test('allows only sips to be spawned', async () => {
    expect(await probe(['--port', '3999'])).toMatchObject({
      'spawn sh': 'blocked',
      'spawn git': 'blocked',
      'spawn python3': 'blocked',
      'spawn curl': 'blocked',
      'sips svg to png': 'allowed',
    })
  })

  test('denies all outbound network by default, including loopback', async () => {
    expect(await probe(['--port', '3999'])).toMatchObject({ 'connect to loopback listener': 'blocked' })
  })

  test('--egress opens TCP 443 only, so a loopback listener stays unreachable', async () => {
    expect(await probe(['--port', '3999', '--egress'])).toMatchObject({ 'connect to loopback listener': 'blocked' })
  })

  describe('web server under the sandbox', () => {
    /** Free loopback port for the server. */
    function freePort() {
      const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
      const { port } = s
      s.stop(true)
      return port
    }

    test('boots, listens on its port, serves requests and drains on SIGTERM', async () => {
      const port = freePort()
      const proc = Bun.spawn(
        ['/bin/sh', WRAPPER, '--port', String(port), '--egress', '--', BUN, 'run', join(REPO, 'cli.js'), 'web', 'serve', '--port', String(port)],
        {
          env: {
            PATH: process.env.PATH, HOME: homedir(), SANDBOX_SERVE: 'on',
            REPO_DIR: REPO, DATA_DIR: dataDir, OPS_DIR: opsDir, BUN_BIN: BUN, APPLE_DOCS_HOME: dataDir,
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      try {
        // Wait on the "listening" log line, not on a timer.
        const reader = proc.stdout.getReader()
        const decoder = new TextDecoder()
        let seen = ''
        while (!seen.includes('Dev server running')) {
          const { value, done } = await reader.read()
          if (done) throw new Error(`server exited before listening:\n${seen}\n${await new Response(proc.stderr).text()}`)
          seen += decoder.decode(value)
        }
        const base = `http://127.0.0.1:${port}`
        const health = await (await fetch(`${base}/healthz`)).json()
        expect(health).toMatchObject({ ok: true, service: 'apple-docs-web' })
        // The commit is resolved by the wrapper because git cannot run inside the sandbox.
        expect(health.commit).toMatch(/^[0-9a-f]{7,40}$/)
        expect((await fetch(`${base}/readyz`)).status).toBe(200)
        expect((await fetch(`${base}/api/search?q=view`)).status).toBe(200)
      } finally {
        proc.kill('SIGTERM')
        await proc.exited
      }
      expect(proc.exitCode).toBe(0)
    })
  })
})

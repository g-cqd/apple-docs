import { describe, test, expect } from 'bun:test'
import runInstallDaemons from '../../../ops/cmd/install-daemons.js'

function captureLogger() {
  const lines = []
  return { lines, say: m => lines.push(m), warn: m => lines.push('W:' + m), error: m => lines.push('E:' + m) }
}

function envFixture(extra = {}) {
  return {
    opsDir: '/fake/ops',
    bunBin: '/usr/local/bin/bun',
    vars: {
      LABEL_PREFIX: 'mt.test',
      LABEL_PROXY: 'mt.test.proxy', LABEL_WEB: 'mt.test.web', LABEL_MCP: 'mt.test.mcp',
      LABEL_WATCHDOG: 'mt.test.watchdog',
      LABEL_TUNNEL_WEB: 'mt.test.cloudflared.web',
      LABEL_TUNNEL_MCP: 'mt.test.cloudflared.mcp',
      USER_NAME: 'gc',
      LEGACY_LAUNCHD_LABELS: '',
      ...extra,
    },
  }
}

const fakeRunner = () => {
  const calls = []
  const fn = async (args, opts) => {
    calls.push({ args, opts })
    return { args, exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }
  }
  return { calls, fn }
}

describe('runInstallDaemons', () => {
  test('refuses to run as non-root', async () => {
    const log = captureLogger()
    const code = await runInstallDaemons({
      logger: log, envLoader: () => envFixture(),
      deps: { isRoot: () => false },
    })
    expect(code).toBe(1)
    expect(log.lines.some(m => m.includes('must be run as root'))).toBe(true)
  })

  test('walks the full install flow when root', async () => {
    const runner = fakeRunner()
    const allow = fakeRunner()
    const sleeps = []
    const renderCalls = []
    const smokeCalls = []
    const log = captureLogger()
    const deps = {
      isRoot: () => true,
      runCmd: runner.fn,
      runCmdAllowFailure: allow.fn,
      exists: () => true,
      bootout: async () => {},
      bootstrapOrKick: async () => ({ kind: 'bootstrapped' }),
      isLoaded: async () => false,
      kickstart: async () => {},
      sleep: async (ms) => { sleeps.push(ms) },
      renderAll: async (ctx) => { renderCalls.push(ctx.args); return 0 },
      smokeTest: async (ctx) => { smokeCalls.push(ctx); return 0 },
    }
    const code = await runInstallDaemons({
      logger: log, envLoader: () => envFixture(), deps,
    })
    expect(code).toBe(0)

    // renderAll was called.
    expect(renderCalls).toEqual([[]])

    // visudo was called against the rendered sudoers file.
    expect(runner.calls.some(c =>
      c.args[0] === '/usr/sbin/visudo' && c.args.includes('-cf')
        && c.args[c.args.length - 1] === '/fake/ops/launchd/sudoers.apple-docs-launchctl',
    )).toBe(true)

    // sudoers was installed to /etc/sudoers.d/mt_test-launchctl with mode 440.
    const installSudoers = runner.calls.find(c =>
      c.args[0] === '/usr/bin/install' && c.args.includes('440'),
    )
    expect(installSudoers).toBeDefined()
    expect(installSudoers.args.at(-1)).toBe('/etc/sudoers.d/mt_test-launchctl')

    // plists installed for each label with mode 644.
    const plistInstalls = runner.calls.filter(c =>
      c.args[0] === '/usr/bin/install' && c.args.includes('644'),
    )
    expect(plistInstalls.length).toBe(6) // 4 app + 2 tunnel labels

    // smoke-test was run after the 8s settle sleep.
    expect(sleeps).toContain(8_000)
    expect(smokeCalls).toHaveLength(1)
  })

  test('processes LEGACY_LAUNCHD_LABELS when set', async () => {
    const runner = fakeRunner()
    const allow = fakeRunner()
    const bootoutCalls = []
    const deps = {
      isRoot: () => true,
      runCmd: runner.fn, runCmdAllowFailure: allow.fn,
      exists: () => true,
      bootout: async (label) => { bootoutCalls.push(label) },
      bootstrapOrKick: async () => ({}),
      isLoaded: async () => false,
      kickstart: async () => {},
      sleep: async () => {},
      renderAll: async () => 0,
      smokeTest: async () => 0,
    }
    await runInstallDaemons({
      logger: captureLogger(),
      envLoader: () => envFixture({ LEGACY_LAUNCHD_LABELS: 'old.label.a, old.label.b' }),
      deps,
    })
    expect(bootoutCalls).toEqual(expect.arrayContaining(['old.label.a', 'old.label.b']))
    const rmCalls = allow.calls.filter(c => c.args[0] === '/bin/rm')
    expect(rmCalls.some(c => c.args.at(-1) === '/Library/LaunchDaemons/old.label.a.plist')).toBe(true)
    expect(rmCalls.some(c => c.args.at(-1) === '/Library/LaunchDaemons/old.label.b.plist')).toBe(true)
  })

  test('aborts early when renderAll fails', async () => {
    const code = await runInstallDaemons({
      logger: captureLogger(),
      envLoader: () => envFixture(),
      deps: {
        isRoot: () => true,
        runCmd: fakeRunner().fn, runCmdAllowFailure: fakeRunner().fn,
        bootout: async () => {}, bootstrapOrKick: async () => ({}), isLoaded: async () => false,
        kickstart: async () => {}, sleep: async () => {},
        renderAll: async () => 1,
        smokeTest: async () => 0,
      },
    })
    expect(code).toBe(1)
  })
})

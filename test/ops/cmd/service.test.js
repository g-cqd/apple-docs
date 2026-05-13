import { describe, test, expect } from 'bun:test'
import runService, { resolveTarget, expandTargets } from '../../../ops/cmd/service.js'

const ENV = {
  vars: {
    LABEL_PROXY: 'mt.test.proxy',
    LABEL_WEB: 'mt.test.web',
    LABEL_MCP: 'mt.test.mcp',
    LABEL_WATCHDOG: 'mt.test.watchdog',
    LABEL_TUNNEL_WEB: 'mt.test.cloudflared.web',
    LABEL_TUNNEL_MCP: 'mt.test.cloudflared.mcp',
  },
}

function captureLogger() {
  const lines = []
  return { lines, say: m => lines.push(m), warn: m => lines.push('W:' + m), error: m => lines.push('E:' + m) }
}

describe('resolveTarget', () => {
  test('returns label + plist path for each known target', () => {
    expect(resolveTarget('web', ENV).label).toBe('mt.test.web')
    expect(resolveTarget('web', ENV).plistPath).toBe('/Library/LaunchDaemons/mt.test.web.plist')
    expect(resolveTarget('tunnel-mcp', ENV).label).toBe('mt.test.cloudflared.mcp')
  })
  test('throws on unknown target', () => {
    expect(() => resolveTarget('zappa', ENV)).toThrow(/unknown target/)
  })
})

describe('expandTargets', () => {
  test('returns [target] for non-all', () => {
    expect(expandTargets('web', 'start')).toEqual(['web'])
  })
  test('all + start uses startup order (watchdog last)', () => {
    const list = expandTargets('all', 'start')
    expect(list).toEqual(['web', 'mcp', 'tunnel-web', 'tunnel-mcp', 'proxy', 'watchdog'])
  })
  test('all + stop uses reverse order (watchdog first)', () => {
    const list = expandTargets('all', 'stop')
    expect(list[0]).toBe('watchdog')
    expect(list[list.length - 1]).toBe('web')
  })
})

describe('runService', () => {
  test('start of unloaded service calls bootstrapOrKick', async () => {
    const calls = []
    const deps = {
      isLoaded: async () => false,
      bootstrapOrKick: async (label, plistPath) => { calls.push({ verb: 'bootstrap', label, plistPath }); return { kind: 'bootstrapped' } },
      bootout: async () => {}, kickstart: async () => {}, runCmdAllowFailure: async () => ({ exitCode: 0 }),
    }
    const code = await runService({ args: ['start', 'web'], envLoader: () => ENV, logger: captureLogger(), deps })
    expect(code).toBe(0)
    expect(calls).toEqual([{ verb: 'bootstrap', label: 'mt.test.web', plistPath: '/Library/LaunchDaemons/mt.test.web.plist' }])
  })

  test('start of loaded service calls kickstart instead', async () => {
    const calls = []
    const deps = {
      isLoaded: async () => true,
      bootstrapOrKick: async () => { throw new Error('should not bootstrap') },
      bootout: async () => {},
      kickstart: async (label) => { calls.push({ verb: 'kickstart', label }) },
      runCmdAllowFailure: async () => ({ exitCode: 0 }),
    }
    const code = await runService({ args: ['start', 'mcp'], envLoader: () => ENV, logger: captureLogger(), deps })
    expect(code).toBe(0)
    expect(calls).toEqual([{ verb: 'kickstart', label: 'mt.test.mcp' }])
  })

  test('stop calls bootout', async () => {
    const calls = []
    const deps = {
      isLoaded: async () => true,
      bootstrapOrKick: async () => {},
      bootout: async (label) => { calls.push(label) },
      kickstart: async () => {},
      runCmdAllowFailure: async () => ({ exitCode: 0 }),
    }
    const code = await runService({ args: ['stop', 'watchdog'], envLoader: () => ENV, logger: captureLogger(), deps })
    expect(code).toBe(0)
    expect(calls).toEqual(['mt.test.watchdog'])
  })

  test('all + start fans out in dependency order', async () => {
    const fanout = []
    const deps = {
      isLoaded: async () => false,
      bootstrapOrKick: async (label) => { fanout.push(label) },
      bootout: async () => {}, kickstart: async () => {}, runCmdAllowFailure: async () => ({ exitCode: 0 }),
    }
    await runService({ args: ['start', 'all'], envLoader: () => ENV, logger: captureLogger(), deps })
    expect(fanout).toEqual([
      'mt.test.web', 'mt.test.mcp', 'mt.test.cloudflared.web', 'mt.test.cloudflared.mcp',
      'mt.test.proxy', 'mt.test.watchdog',
    ])
  })

  test('status still exits 0 when service is missing, but logs the launchctl stderr', async () => {
    // Matches the bash `service_status … || true` behaviour: status
    // verb is informational, not a deploy gate.
    const log = captureLogger()
    const deps = {
      isLoaded: async () => false,
      bootstrapOrKick: async () => {}, bootout: async () => {}, kickstart: async () => {},
      runCmdAllowFailure: async () => ({ exitCode: 113, stdout: '', stderr: 'Could not find service "mt.test.web" in domain for system' }),
    }
    const code = await runService({ args: ['status', 'web'], envLoader: () => ENV, logger: log, deps })
    expect(code).toBe(0)
    expect(log.lines.some(m => m.includes('Could not find service'))).toBe(true)
  })

  test('unknown verb returns 64', async () => {
    const code = await runService({ args: ['frobnicate', 'web'], envLoader: () => ENV, logger: captureLogger() })
    expect(code).toBe(64)
  })

  test('unknown target returns 64', async () => {
    const code = await runService({ args: ['start', 'zappa'], envLoader: () => ENV, logger: captureLogger() })
    expect(code).toBe(64)
  })
})

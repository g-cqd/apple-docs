// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../../../src/config.js'
import { ConfigError } from '../../../src/lib/errors.js'

/**
 * Schema-vs-runtime parity for `src/config.js`. Each test feeds
 * `loadConfig()` a synthetic env block and asserts the parsed value
 * matches what the runtime modules expect to consume.
 *
 * The original regression these tests are designed to catch:
 * APPLE_DOCS_MCP_READERS was declared as `posInt().optional()` but the
 * MCP runtime (src/mcp/http-server.js) treats it as a string toggle
 * `=== 'on'`. The launchd plist correctly sets `APPLE_DOCS_MCP_READERS=on`,
 * which crash-looped production for ~5 minutes during a rollout.
 */

/** Empty env — keeps loadConfig from picking up the host's process.env. */
function blank() {
  return {}
}

describe('loadConfig — defaults', () => {
  test('returns the documented defaults when nothing is set', () => {
    const cfg = loadConfig(blank())
    expect(cfg.APPLE_DOCS_LOG_LEVEL).toBe('info')
    expect(cfg.APPLE_DOCS_DEBUG).toBe(false)
    expect(cfg.APPLE_DOCS_PARALLEL).toBe(10)
    expect(cfg.APPLE_DOCS_TIMEOUT).toBe(30_000)
    expect(cfg.APPLE_DOCS_HOST_BUCKET_MAX).toBe(256)
    expect(cfg.APPLE_DOCS_SKIP_RESOURCES).toBe(false)
    expect(cfg.APPLE_DOCS_SYMBOLS_OFFLINE).toBe(false)
    expect(cfg.APPLE_DOCS_PACKAGES_SCOPE).toBe('official')
    expect(cfg.APPLE_DOCS_PACKAGES_FETCH).toBe('raw')
    expect(cfg.APPLE_DOCS_BUILD_WORKER).toBe(false)
    expect(cfg.APPLE_DOCS_MCP_CACHE).toBe('on')
    expect(cfg.APPLE_DOCS_MCP_CACHE_STATS).toBe(false)
    expect(cfg.APPLE_DOCS_MCP_CONCURRENCY).toBe(8)
    expect(cfg.APPLE_DOCS_MCP_QUEUE).toBe(64)
    expect(cfg.APPLE_DOCS_WEB_HOST).toBe('127.0.0.1')
    expect(cfg.APPLE_DOCS_WEB_RATE_LIMIT).toBe(false)
    expect(cfg.APPLE_DOCS_WEB_DEEP_INFLIGHT).toBe(4)
    expect(cfg.APPLE_DOCS_WEB_DEEP_QUEUE).toBe(8)
    expect(cfg.APPLE_DOCS_NO_HIGHLIGHT).toBe(false)
  })

  test('APPLE_DOCS_HOME falls back to ~/.apple-docs', () => {
    const cfg = loadConfig(blank())
    expect(cfg.APPLE_DOCS_HOME).toMatch(/\.apple-docs$/)
  })
})

describe('loadConfig — launchd plist parity', () => {
  // Mirrors the env block in ops/launchd/apple-docs.mcp.plist.tpl.
  // The READERS toggle is the bug we just regressed on; the test asserts
  // the schema accepts the exact string ("on") the plist sets.
  test('parses the production MCP plist env block', () => {
    const env = {
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/Users/operator',
      APPLE_DOCS_HOME: '/Users/operator/.apple-docs',
      APPLE_DOCS_MCP_CONCURRENCY: '8',
      APPLE_DOCS_MCP_QUEUE: '64',
      APPLE_DOCS_MCP_READERS: 'on',
      APPLE_DOCS_MCP_READER_WORKERS: '8',
      APPLE_DOCS_MCP_CACHE_STATS: '1',
      APPLE_DOCS_MCP_CACHE_SCALE: '5',
    }
    const cfg = loadConfig(env)
    expect(cfg.APPLE_DOCS_MCP_CONCURRENCY).toBe(8)
    expect(cfg.APPLE_DOCS_MCP_QUEUE).toBe(64)
    expect(cfg.APPLE_DOCS_MCP_READERS).toBe('on')
    expect(cfg.APPLE_DOCS_MCP_READER_WORKERS).toBe(8)
    expect(cfg.APPLE_DOCS_MCP_CACHE_STATS).toBe(true)
    expect(cfg.APPLE_DOCS_MCP_CACHE_SCALE).toBe(5)
    expect(cfg.APPLE_DOCS_HOME).toBe('/Users/operator/.apple-docs')
  })

  test('parses the production Web plist env block', () => {
    const env = {
      PATH: '/opt/homebrew/bin:/usr/local/bin',
      HOME: '/Users/operator',
      APPLE_DOCS_HOME: '/Users/operator/.apple-docs',
    }
    const cfg = loadConfig(env)
    expect(cfg.APPLE_DOCS_HOME).toBe('/Users/operator/.apple-docs')
    // Web plist leaves the rate-limit + reader-pool unset; defaults apply.
    expect(cfg.APPLE_DOCS_WEB_RATE_LIMIT).toBe(false)
    expect(cfg.APPLE_DOCS_WEB_READERS).toBeUndefined()
  })
})

describe('loadConfig — bool coercion', () => {
  const TRUTHY = ['1', 'true', 'on', 'yes', 'TRUE', 'On', 'YES']
  const FALSY = ['0', 'false', 'off', 'no', '', 'FALSE', 'Off', 'NO']
  for (const v of TRUTHY) {
    test(`APPLE_DOCS_DEBUG="${v}" → true`, () => {
      expect(loadConfig({ APPLE_DOCS_DEBUG: v }).APPLE_DOCS_DEBUG).toBe(true)
    })
  }
  for (const v of FALSY) {
    test(`APPLE_DOCS_DEBUG="${v}" → false`, () => {
      expect(loadConfig({ APPLE_DOCS_DEBUG: v }).APPLE_DOCS_DEBUG).toBe(false)
    })
  }
})

describe('loadConfig — reader-pool toggles (regression coverage)', () => {
  test('APPLE_DOCS_MCP_READERS accepts "on"', () => {
    expect(loadConfig({ APPLE_DOCS_MCP_READERS: 'on' }).APPLE_DOCS_MCP_READERS).toBe('on')
  })

  test('APPLE_DOCS_MCP_READERS accepts "off"', () => {
    expect(loadConfig({ APPLE_DOCS_MCP_READERS: 'off' }).APPLE_DOCS_MCP_READERS).toBe('off')
  })

  test('APPLE_DOCS_MCP_READERS rejects numeric strings', () => {
    expect(() => loadConfig({ APPLE_DOCS_MCP_READERS: '8' })).toThrow(ConfigError)
  })

  test('APPLE_DOCS_MCP_READERS rejects "true"', () => {
    expect(() => loadConfig({ APPLE_DOCS_MCP_READERS: 'true' })).toThrow(ConfigError)
  })

  test('APPLE_DOCS_WEB_READERS accepts "auto" (default mode in src/web/context.js)', () => {
    expect(loadConfig({ APPLE_DOCS_WEB_READERS: 'auto' }).APPLE_DOCS_WEB_READERS).toBe('auto')
  })

  test('APPLE_DOCS_WEB_READERS accepts "on"', () => {
    expect(loadConfig({ APPLE_DOCS_WEB_READERS: 'on' }).APPLE_DOCS_WEB_READERS).toBe('on')
  })

  test('APPLE_DOCS_WEB_READERS accepts "off"', () => {
    expect(loadConfig({ APPLE_DOCS_WEB_READERS: 'off' }).APPLE_DOCS_WEB_READERS).toBe('off')
  })

  test('APPLE_DOCS_WEB_READERS rejects numeric strings', () => {
    expect(() => loadConfig({ APPLE_DOCS_WEB_READERS: '4' })).toThrow(ConfigError)
  })

  // Counts are numbers — they sit alongside the toggle and the schema
  // must NOT confuse the two.
  test('APPLE_DOCS_MCP_READER_WORKERS still requires a positive integer', () => {
    expect(loadConfig({ APPLE_DOCS_MCP_READER_WORKERS: '12' }).APPLE_DOCS_MCP_READER_WORKERS).toBe(12)
    expect(() => loadConfig({ APPLE_DOCS_MCP_READER_WORKERS: 'on' })).toThrow(ConfigError)
    expect(() => loadConfig({ APPLE_DOCS_MCP_READER_WORKERS: '0' })).toThrow(ConfigError)
  })
})

describe('loadConfig — enum validation', () => {
  test('APPLE_DOCS_LOG_LEVEL accepts only the documented levels', () => {
    for (const v of ['debug', 'info', 'warn', 'error']) {
      expect(loadConfig({ APPLE_DOCS_LOG_LEVEL: v }).APPLE_DOCS_LOG_LEVEL).toBe(v)
    }
    expect(() => loadConfig({ APPLE_DOCS_LOG_LEVEL: 'trace' })).toThrow(ConfigError)
    expect(() => loadConfig({ APPLE_DOCS_LOG_LEVEL: 'WARN' })).toThrow(ConfigError) // case-sensitive
  })

  test('APPLE_DOCS_MCP_CACHE only accepts on/off', () => {
    expect(loadConfig({ APPLE_DOCS_MCP_CACHE: 'on' }).APPLE_DOCS_MCP_CACHE).toBe('on')
    expect(loadConfig({ APPLE_DOCS_MCP_CACHE: 'off' }).APPLE_DOCS_MCP_CACHE).toBe('off')
    expect(() => loadConfig({ APPLE_DOCS_MCP_CACHE: '1' })).toThrow(ConfigError)
  })

  test('APPLE_DOCS_PACKAGES_SCOPE only accepts official/full', () => {
    expect(loadConfig({ APPLE_DOCS_PACKAGES_SCOPE: 'full' }).APPLE_DOCS_PACKAGES_SCOPE).toBe('full')
    expect(() => loadConfig({ APPLE_DOCS_PACKAGES_SCOPE: 'partial' })).toThrow(ConfigError)
  })

  test('APPLE_DOCS_PACKAGES_FETCH only accepts raw/api', () => {
    expect(loadConfig({ APPLE_DOCS_PACKAGES_FETCH: 'api' }).APPLE_DOCS_PACKAGES_FETCH).toBe('api')
    expect(() => loadConfig({ APPLE_DOCS_PACKAGES_FETCH: 'graphql' })).toThrow(ConfigError)
  })
})

describe('loadConfig — numeric coercion + ranges', () => {
  test('positive integers reject zero, negatives, and NaN', () => {
    expect(() => loadConfig({ APPLE_DOCS_MCP_CONCURRENCY: '0' })).toThrow(ConfigError)
    expect(() => loadConfig({ APPLE_DOCS_MCP_CONCURRENCY: '-1' })).toThrow(ConfigError)
    expect(() => loadConfig({ APPLE_DOCS_MCP_CONCURRENCY: 'eight' })).toThrow(ConfigError)
  })

  test('non-negative integers accept zero', () => {
    expect(loadConfig({ APPLE_DOCS_MCP_QUEUE: '0' }).APPLE_DOCS_MCP_QUEUE).toBe(0)
    expect(loadConfig({ APPLE_DOCS_WEB_DEEP_QUEUE: '0' }).APPLE_DOCS_WEB_DEEP_QUEUE).toBe(0)
    expect(() => loadConfig({ APPLE_DOCS_MCP_QUEUE: '-1' })).toThrow(ConfigError)
  })

  test('integers reject fractional values', () => {
    expect(() => loadConfig({ APPLE_DOCS_PARALLEL: '4.5' })).toThrow(ConfigError)
  })

  test('APPLE_DOCS_MCP_CACHE_SCALE accepts fractional positives', () => {
    expect(loadConfig({ APPLE_DOCS_MCP_CACHE_SCALE: '0.5' }).APPLE_DOCS_MCP_CACHE_SCALE).toBe(0.5)
    expect(loadConfig({ APPLE_DOCS_MCP_CACHE_SCALE: '2.5' }).APPLE_DOCS_MCP_CACHE_SCALE).toBe(2.5)
    expect(() => loadConfig({ APPLE_DOCS_MCP_CACHE_SCALE: '-1' })).toThrow(ConfigError)
    expect(() => loadConfig({ APPLE_DOCS_MCP_CACHE_SCALE: '0' })).toThrow(ConfigError)
  })
})

describe('loadConfig — URL + token shapes', () => {
  test('APPLE_DOCS_API_BASE must parse as a URL', () => {
    expect(loadConfig({ APPLE_DOCS_API_BASE: 'https://example.com/api' }).APPLE_DOCS_API_BASE).toBe('https://example.com/api')
    expect(() => loadConfig({ APPLE_DOCS_API_BASE: 'not-a-url' })).toThrow(ConfigError)
  })

  test('GITHUB_TOKEN passes through as-is', () => {
    expect(loadConfig({ GITHUB_TOKEN: 'ghp_test123' }).GITHUB_TOKEN).toBe('ghp_test123')
  })
})

describe('loadConfig — passthrough and error formatting', () => {
  test('unknown env keys do not cause failure', () => {
    const cfg = loadConfig({ UNKNOWN_VAR: 'whatever', SHELL: '/bin/zsh' })
    expect(cfg.UNKNOWN_VAR).toBe('whatever')
    expect(cfg.SHELL).toBe('/bin/zsh')
  })

  test('ConfigError lists every offending field in one message', () => {
    try {
      loadConfig({
        APPLE_DOCS_LOG_LEVEL: 'nope',
        APPLE_DOCS_MCP_READERS: 'maybe',
        APPLE_DOCS_PARALLEL: 'abc',
      })
      throw new Error('expected ConfigError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect(err.message).toContain('APPLE_DOCS_LOG_LEVEL')
      expect(err.message).toContain('APPLE_DOCS_MCP_READERS')
      expect(err.message).toContain('APPLE_DOCS_PARALLEL')
    }
  })

  test('returned config is frozen', () => {
    const cfg = loadConfig(blank())
    expect(Object.isFrozen(cfg)).toBe(true)
    expect(() => {
      cfg.APPLE_DOCS_LOG_LEVEL = 'debug'
    }).toThrow()
  })
})

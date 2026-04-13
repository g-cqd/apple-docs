/**
 * Shared mock factories for test files.
 */

/**
 * Create a mock logger with spy-like tracking.
 */
export function createMockLogger() {
  const calls = { info: [], warn: [], error: [], debug: [] }
  return {
    info(...args) { calls.info.push(args) },
    warn(...args) { calls.warn.push(args) },
    error(...args) { calls.error.push(args) },
    debug(...args) { calls.debug.push(args) },
    _calls: calls,
  }
}

/**
 * Create a mock rate limiter (no-op).
 */
export function createMockRateLimiter() {
  return { acquire: async () => {} }
}


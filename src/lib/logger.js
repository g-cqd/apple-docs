const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

export function createLogger(level = process.env.APPLE_DOCS_LOG_LEVEL || 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info

  function log(lvl, msg, data) {
    if (LEVELS[lvl] < threshold) return
    const entry = { ts: new Date().toISOString(), level: lvl, msg }
    if (data !== undefined) entry.data = data
    process.stderr.write(JSON.stringify(entry) + '\n')
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
  }
}

import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_HISTORY_DIR = join(import.meta.dir, '..', '..', '.benchmarks')

/**
 * Record a benchmark result to a JSONL history file.
 * @param {string} name - Benchmark name (e.g. 'search-p50')
 * @param {object} metrics - { value, unit, ... }
 * @param {{ historyDir?: string }} opts
 */
export function recordBenchmark(name, metrics, opts = {}) {
  const dir = opts.historyDir ?? DEFAULT_HISTORY_DIR
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'history.jsonl')
  const entry = {
    name,
    ...metrics,
    timestamp: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
  }
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`)
  return entry
}

/**
 * Read benchmark history entries.
 * @param {string} name - Filter by benchmark name
 * @param {{ limit?: number, historyDir?: string }} opts
 * @returns {object[]}
 */
export function readHistory(name, opts = {}) {
  const dir = opts.historyDir ?? DEFAULT_HISTORY_DIR
  const filePath = join(dir, 'history.jsonl')
  if (!existsSync(filePath)) return []

  const lines = readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
  let entries = lines.map(l => JSON.parse(l))

  if (name) {
    entries = entries.filter(e => e.name === name)
  }

  if (opts.limit) {
    entries = entries.slice(-opts.limit)
  }

  return entries
}

/**
 * Compare current metric to previous recorded value.
 * Returns regression info if >20% slower.
 * @param {string} name
 * @param {number} currentValue
 * @param {{ historyDir?: string }} opts
 * @returns {{ regressed: boolean, previousValue?: number, change?: number, changePercent?: number }}
 */
export function compareToPrevious(name, currentValue, opts = {}) {
  const history = readHistory(name, { limit: 1, ...opts })
  if (history.length === 0) {
    return { regressed: false }
  }

  const prev = history[history.length - 1]
  const previousValue = prev.value
  const change = currentValue - previousValue
  const changePercent = previousValue > 0 ? Math.round((change / previousValue) * 100) : 0

  return {
    regressed: changePercent > 20,
    previousValue,
    change,
    changePercent,
  }
}

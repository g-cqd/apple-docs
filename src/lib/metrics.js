/**
 * Prometheus exposition-format encoder.
 *
 * Minimal `/metrics` endpoint shared between `apple-docs web serve` and
 * `apple-docs mcp serve`. Off by default — only spun up when the
 * operator passes `--metrics-port`. The format is plain text (no client
 * library, no dependency);
 * see https://prometheus.io/docs/instrumenting/exposition_formats/.
 *
 * Input shape:
 *   [{ name: string, help: string, type: 'counter'|'gauge',
 *      samples: [{ labels?: Record<string,string|number>, value: number }] }]
 *
 * Notes:
 *   - Samples with non-finite values (NaN, ±Infinity, undefined, null) are
 *     skipped — Prometheus rejects them and emitting them would 500 the scrape.
 *   - Label values are escaped per the spec: `\` → `\\`, `"` → `\"`, newline
 *     → `\n`. Names are not escaped — caller is responsible for using
 *     `[a-zA-Z_:][a-zA-Z0-9_:]*` identifiers.
 *   - Empty samples still emit `# HELP` / `# TYPE` lines so a scraper can
 *     differentiate "metric registered, no observations" from "unknown metric".
 *   - Output ends with a trailing newline (required by the format).
 */

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

export function formatPrometheus(metrics) {
  if (!Array.isArray(metrics)) return ''
  const out = []
  for (const metric of metrics) {
    if (!metric || typeof metric.name !== 'string') continue
    const help = escapeHelp(metric.help ?? '')
    const type = metric.type === 'counter' ? 'counter' : 'gauge'
    out.push(`# HELP ${metric.name} ${help}`)
    out.push(`# TYPE ${metric.name} ${type}`)
    for (const sample of metric.samples ?? []) {
      const value = sample?.value
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      out.push(`${metric.name}${formatLabels(sample.labels)} ${formatValue(value)}`)
    }
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

function formatLabels(labels) {
  if (!labels || typeof labels !== 'object') return ''
  const keys = Object.keys(labels)
  if (keys.length === 0) return ''
  const parts = []
  for (const k of keys) {
    const v = labels[k]
    if (v == null) continue
    parts.push(`${k}="${escapeLabelValue(String(v))}"`)
  }
  return parts.length === 0 ? '' : `{${parts.join(',')}}`
}

function escapeLabelValue(value) {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i)
    if (ch === 0x5c) out += '\\\\'         // backslash
    else if (ch === 0x22) out += '\\"'     // double-quote
    else if (ch === 0x0a) out += '\\n'     // newline
    else out += value[i]
  }
  return out
}

function escapeHelp(value) {
  // HELP lines escape backslash and newline only (double-quotes are literal).
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i)
    if (ch === 0x5c) out += '\\\\'
    else if (ch === 0x0a) out += '\\n'
    else out += value[i]
  }
  return out
}

function formatValue(value) {
  // Integers stay integers (cleaner scrape output); fractional values keep
  // full JS precision via toString — Prometheus parses scientific notation.
  if (Number.isInteger(value)) return String(value)
  return value.toString()
}

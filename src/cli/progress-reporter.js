/**
 * Throttled TTY progress reporter for `web build`. Emits at most once per
 * second and replaces the line with a carriage return; computes a smoothed
 * rate from a sliding window so a paused-but-resumable build doesn't quote
 * a bogus 0/s instantaneous rate.
 */
export function makeProgressReporter() {
  const startTs = Date.now()
  let lastFlush = 0
  const window = []
  const WINDOW_MS = 5_000

  const fmt = (n) => n.toLocaleString('en-US')
  const fmtBytes = (b) => {
    if (b > 1e9) return `${(b / 1e9).toFixed(1)}G`
    if (b > 1e6) return `${(b / 1e6).toFixed(0)}M`
    return `${(b / 1e3).toFixed(0)}K`
  }
  const fmtDuration = (ms) => {
    if (ms < 1000) return `${ms}ms`
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    return `${m}m${String(s % 60).padStart(2, '0')}s`
  }

  function reporter(p) {
    const now = Date.now()
    window.push({ t: now, n: p.total })
    while (window.length > 1 && now - window[0].t > WINDOW_MS) window.shift()

    if (now - lastFlush < 1000) return
    lastFlush = now

    const oldest = window[0]
    const elapsedSec = Math.max(1e-3, (now - oldest.t) / 1000)
    const rate = (p.total - oldest.n) / elapsedSec
    const elapsedTotal = now - startTs
    const line = (
      `[${fmtDuration(elapsedTotal)}] ` +
      `${fmt(p.built)} built, ${fmt(p.skipped)} skipped, ${fmt(p.failed)} failed ` +
      `· ${rate.toFixed(0)}/s ` +
      `· RSS=${fmtBytes(p.rss)}`
    )
    process.stdout.write(`\r${line.padEnd(process.stdout.columns ?? 80, ' ').slice(0, (process.stdout.columns ?? 80) - 1)}`)
  }
  reporter.done = () => {
    if (lastFlush > 0) process.stdout.write('\n')
  }
  return reporter
}

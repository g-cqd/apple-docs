import { bold, formatBytes, } from './_shared.js'

export function formatSync(result) {
  const lines = [bold('Sync complete')]
  const u = result.update
  if (u) {
    lines.push(
      `  Update phase:     ${u.newCount ?? 0} new, ${u.modCount ?? 0} modified, ${u.unchangedCount ?? 0} unchanged, ${u.delCount ?? 0} deleted, ${u.errCount ?? 0} errors`,
    )
  }
  lines.push(
    `  Roots discovered: ${result.rootsDiscovered}`,
    `  Roots crawled:    ${result.rootsCrawled}`,
    `  Downloaded:       ${result.downloaded}`,
    `  Converted:        ${result.converted}`,
    `  Body indexed:     ${result.bodyIndexed ?? 0}`,
  )
  if (result.fonts) {
    const f = result.fonts
    lines.push(`  Fonts:            ${f.families} families, ${f.files} files (${f.system} system, ${f.remote} bundled${f.downloaded ? `, ${f.downloaded} downloaded` : ''})`)
  }
  if (result.symbols) {
    const s = result.symbols
    lines.push(`  SF Symbols:       ${s.public} public, ${s.private} private`)
  }
  if (result.symbolsRender) {
    const r = result.symbolsRender
    lines.push(`  Symbol prerender: ${r.rendered ?? 0} rendered, ${r.skipped ?? 0} skipped, ${r.failed ?? 0} failed`)
  }
  if (result.doctor) {
    const d = result.doctor
    const parts = [
      `cleaned ${d.cleaned ?? 0}`,
      `resolved ${d.resolved ?? 0}`,
      `retried ${d.retried ?? 0}/${d.retriedOk ?? 0} ok`,
      `${d.genuine ?? 0} still missing`,
    ]
    if (d.minified) parts.push(`minified ${d.minified} files (${formatBytes(d.minifySaved ?? 0)})`)
    lines.push(`  Doctor:           ${parts.join(', ')}`)
  }
  if (Array.isArray(result.failedSources) && result.failedSources.length > 0) {
    lines.push(`  Failed sources:   ${result.failedSources.map(f => f.source).join(', ')}`)
  }
  lines.push(`  Duration:         ${(result.durationMs / 1000).toFixed(1)}s`)
  return lines.join('\n')
}


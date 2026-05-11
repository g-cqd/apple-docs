import { bold, dim, formatBytes, } from './_shared.js'

export function formatStatus(result) {
  const fmt = formatBytes

  const bar = (processed, total) => {
    if (total === 0) return ''
    const pct = Math.round((processed / total) * 100)
    const width = 20
    const filled = Math.round((pct / 100) * width)
    return `[${'='.repeat(filled)}${' '.repeat(width - filled)}] ${pct}%`
  }

  const kindStr = Object.entries(result.roots.byKind).map(([k, v]) => `${v} ${k}`).join(', ')

  const tierLabel = result.tier ? ` [${result.tier} tier]` : ''

  const lines = [
    bold(`Apple Documentation Corpus${tierLabel}`),
    `  Data directory:  ${result.dataDir}`,
    `  Database:        ${fmt(result.databaseSize)}`,
    `  Raw JSON:        ${fmt(result.rawJson.size)} (${result.rawJson.files} files)`,
    `  Markdown:        ${fmt(result.markdown.size)} (${result.markdown.files} files)`,
    `  Roots:           ${result.roots.total} (${kindStr || 'none'})`,
    `  Pages:           ${result.pages.active} active, ${result.pages.deleted} deleted`,
    `  Last sync:       ${result.lastSync ?? 'never'}`,
    `  Last action:     ${result.lastAction ?? 'none'}`,
  ]

  if (result.capabilities) {
    const c = result.capabilities
    const caps = []
    caps.push("search: yes")
    caps.push(`fuzzy: ${c.searchTrigram ? 'yes' : 'no'}`)
    caps.push(`body: ${c.searchBody ? 'yes' : 'no'}`)
    caps.push(`read: ${c.readContent ? 'yes' : 'metadata only'}`)
    lines.push(`  Capabilities:    ${caps.join(', ')}`)
  }

  // Activity status
  if (result.activity) {
    lines.push('')
    const a = result.activity
    if (a.status === 'running') {
      const rootsStr = a.roots ? ` (${a.roots.join(', ')})` : ''
      lines.push(bold(`  Active:  ${a.action}${rootsStr} running since ${a.startedAt} [pid ${a.pid}]`))
    } else {
      const rootsStr = a.roots ? ` (${a.roots.join(', ')})` : ''
      lines.push(bold(`  Stopped: ${a.action}${rootsStr} was interrupted (started ${a.startedAt})`))
      lines.push(`           Run "apple-docs sync" again to resume`)
    }
  }

  // Crawl progress
  const cp = result.crawlProgress
  if (cp.total > 0) {
    lines.push('')
    lines.push(bold('  Crawl Progress'))
    lines.push(`  Overall: ${cp.processed} processed, ${cp.pending} pending, ${cp.failed} failed / ${cp.total} total`)
    lines.push(`           ${bar(cp.processed, cp.total)}`)

    // Per-root breakdown (only show roots with pending or failed)
    const active = result.crawlByRoot.filter(r => r.pending > 0 || r.failed > 0)
    const done = result.crawlByRoot.filter(r => r.pending === 0 && r.failed === 0)

    if (active.length > 0) {
      lines.push('')
      lines.push(`  ${bold('In progress / incomplete:')}`)
      for (const r of active) {
        lines.push(`    ${r.root}: ${r.processed}/${r.total} ${bar(r.processed, r.total)}${r.failed > 0 ? dim(` (${r.failed} failed)`) : ''}`)
      }
    }

    if (done.length > 0 && done.length <= 10) {
      lines.push('')
      lines.push(`  ${bold('Complete:')} ${done.map(r => `${r.root} (${r.total})`).join(', ')}`)
    } else if (done.length > 10) {
      lines.push('')
      lines.push(`  ${bold('Complete:')} ${done.length} roots`)
    }
  }

  if (result.updateAvailable?.available) {
    lines.push('')
    lines.push(bold(`  Update available: ${result.updateAvailable.latest}`))
    lines.push(`  Current:  ${result.updateAvailable.current}`)
    lines.push("  Run: apple-docs setup --force")
  }

  if (result.freshness) {
    const f = result.freshness
    lines.push('')
    if (f.lastSyncAt) {
      const staleLabel = f.isStale ? ' (STALE)' : ''
      lines.push(`  Last sync:       ${f.daysSinceSync} days ago${staleLabel}`)
      if (f.staleRoots.length > 0) {
        lines.push(`  Stale roots:     ${f.staleRoots.map(r => `${r.slug} (${r.daysSince}d)`).join(', ')}`)
      }
    } else {
      lines.push("  Freshness:       No sync history")
    }
  }

  return lines.join('\n')
}

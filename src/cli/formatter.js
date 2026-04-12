const isTTY = process.stdout.isTTY

const bold = (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s
const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s

export function formatSearchResults(result) {
  if (result.results.length === 0) {
    return `No results for "${result.query}"`
  }

  const lines = []
  for (const r of result.results) {
    const quality = r.matchQuality ?? 'match'
    const tag = quality === 'match' ? '' : quality === 'fuzzy' ? dim(` [fuzzy d=${r.distance}]`) : dim(` [${quality}]`)
    lines.push(`  ${dim(r.framework + ' / ' + (r.kind ?? ''))}${tag}`)
    lines.push(`  ${bold(r.title)}`)
    if (r.abstract) lines.push(`  ${r.abstract}`)
    lines.push(`  ${dim(r.path)}`)
    lines.push('')
  }
  lines.push(`${result.total} result${result.total !== 1 ? 's' : ''} for "${result.query}"`)
  return lines.join('\n')
}

export function formatLookup(result) {
  if (!result.found) {
    return `Not found: ${result.path}`
  }
  if (!result.content) {
    return result.note ?? 'Markdown not available.'
  }
  return result.content
}

export function formatFrameworks(result) {
  if (result.roots.length === 0) return 'No frameworks found. Run `apple-docs sync` first.'

  const lines = []
  const byKind = {}
  for (const r of result.roots) {
    const k = r.kind ?? 'unknown'
    if (!byKind[k]) byKind[k] = []
    byKind[k].push(r)
  }

  for (const [kind, roots] of Object.entries(byKind)) {
    lines.push(bold(`${kind} (${roots.length})`))
    for (const r of roots) {
      const count = r.pageCount > 0 ? dim(` (${r.pageCount} pages)`) : ''
      lines.push(`  ${r.name}${count}`)
    }
    lines.push('')
  }
  lines.push(`${result.total} total roots`)
  return lines.join('\n')
}

export function formatBrowse(result) {
  if (result.children) {
    const lines = [`${bold(result.title)} ${dim(result.path)}\n`]
    const bySection = {}
    for (const c of result.children) {
      const s = c.section ?? 'other'
      if (!bySection[s]) bySection[s] = []
      bySection[s].push(c)
    }
    for (const [section, children] of Object.entries(bySection)) {
      lines.push(bold(section))
      for (const c of children) {
        lines.push(`  ${c.title ?? c.path}`)
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  const lines = [`${bold(result.framework)} ${dim(`(${result.slug}, ${result.kind})`)}\n`]
  for (const p of result.pages.slice(0, 50)) {
    const kind = p.kind ? dim(` [${p.kind}]`) : ''
    lines.push(`  ${p.title ?? p.path}${kind}`)
  }
  if (result.total > 50) {
    lines.push(dim(`  ... and ${result.total - 50} more`))
  }
  lines.push(`\n${result.total} pages`)
  return lines.join('\n')
}

export function formatStatus(result) {
  const fmt = (bytes) => {
    if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
    if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
    return `${bytes} B`
  }

  const bar = (processed, total) => {
    if (total === 0) return ''
    const pct = Math.round((processed / total) * 100)
    const width = 20
    const filled = Math.round((pct / 100) * width)
    return `[${'='.repeat(filled)}${' '.repeat(width - filled)}] ${pct}%`
  }

  const kindStr = Object.entries(result.roots.byKind).map(([k, v]) => `${v} ${k}`).join(', ')

  const lines = [
    bold('Apple Documentation Corpus'),
    `  Data directory:  ${result.dataDir}`,
    `  Database:        ${fmt(result.databaseSize)}`,
    `  Raw JSON:        ${fmt(result.rawJson.size)} (${result.rawJson.files} files)`,
    `  Markdown:        ${fmt(result.markdown.size)} (${result.markdown.files} files)`,
    `  Roots:           ${result.roots.total} (${kindStr || 'none'})`,
    `  Pages:           ${result.pages.active} active, ${result.pages.deleted} deleted`,
    `  Last sync:       ${result.lastSync ?? 'never'}`,
    `  Last action:     ${result.lastAction ?? 'none'}`,
  ]

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

  return lines.join('\n')
}

export function formatSync(result) {
  return [
    bold('Sync complete'),
    `  Roots discovered: ${result.rootsDiscovered}`,
    `  Roots crawled:    ${result.rootsCrawled}`,
    `  Downloaded:       ${result.downloaded}`,
    `  Converted:        ${result.converted}`,
    `  Duration:         ${(result.durationMs / 1000).toFixed(1)}s`,
  ].join('\n')
}

export function formatUpdate(result) {
  return [
    bold('Update complete'),
    `  New:        ${result.newCount}`,
    `  Modified:   ${result.modCount}`,
    `  Unchanged:  ${result.unchangedCount}`,
    `  Deleted:    ${result.delCount}`,
    `  Errors:     ${result.errCount}`,
    `  Duration:   ${(result.durationMs / 1000).toFixed(1)}s`,
  ].join('\n')
}

export function formatConsolidate(result) {
  const lines = [
    bold(result.dryRun ? 'Consolidate (dry run)' : 'Consolidate complete'),
    `  Analyzed:        ${result.analyzed} failed entries`,
    `  Cleaned:         ${result.cleaned} (fragments, dot-operators, bad URLs)`,
    `  Resolved:        ${result.resolved} (found correct URL via parent page)`,
  ]

  if (!result.dryRun) {
    lines.push(`  Retried:         ${result.retried} (${result.retriedOk} succeeded)`)
  }

  lines.push(`  Remaining:       ${result.genuine} genuinely missing pages`)

  if (result.minified > 0) {
    const fmt = (b) => b > 1e9 ? `${(b/1e9).toFixed(1)} GB` : b > 1e6 ? `${(b/1e6).toFixed(1)} MB` : `${(b/1e3).toFixed(1)} KB`
    lines.push(`  Minified:        ${result.minified} JSON files (saved ${fmt(result.minifySaved)})`)
  }

  if (result.dryRun && result.resolvedPaths?.length > 0) {
    lines.push('')
    lines.push(bold('  Would retry:'))
    for (const r of result.resolvedPaths.slice(0, 20)) {
      lines.push(dim(`    ${r.oldPath}`))
      lines.push(`    → ${r.newPath}`)
    }
    if (result.resolvedPaths.length > 20) {
      lines.push(dim(`    ... and ${result.resolvedPaths.length - 20} more`))
    }
  }

  return lines.join('\n')
}

export function formatIndex(result) {
  return [
    bold('Index complete'),
    `  Indexed:  ${result.indexed} pages`,
    `  Total:    ${result.total}`,
    `  Errors:   ${result.errors}`,
  ].join('\n')
}

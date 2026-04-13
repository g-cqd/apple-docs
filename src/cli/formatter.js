const isTTY = process.stdout.isTTY

const bold = (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s
const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s

function formatBytes(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} B`
}

export function formatSearchResults(result) {
  if (result.results.length === 0) {
    return `No results for "${result.query}"`
  }

  const lines = []
  for (const r of result.results) {
    const quality = r.matchQuality ?? 'match'
    const tag = quality === 'match' ? '' : quality === 'fuzzy' ? dim(` [fuzzy d=${r.distance}]`) : dim(` [${quality}]`)
    const sourceLabel = r.sourceType ? `${r.sourceType} / ` : ''
    lines.push(`  ${dim(`${sourceLabel + r.framework} / ${r.kind ?? ''}`)}${tag}`)
    lines.push(`  ${bold(r.title)}`)
    if (r.abstract) lines.push(`  ${r.abstract}`)
    if (r.snippet && r.snippet !== r.abstract) lines.push(`  ${dim(r.snippet)}`)
    if (r.relatedCount > 0) lines.push(`  ${dim(`↳ ${r.relatedCount} related`)}`)
    lines.push(`  ${dim(r.path)}`)
    lines.push('')
  }
  lines.push(`${result.total} result${result.total !== 1 ? 's' : ''} for "${result.query}"`)
  return lines.join('\n')
}

export function formatSearchRead(result) {
  const { hit, page } = result
  const quality = hit.matchQuality ?? 'match'
  const lines = [
    `  ${dim('┌')} Best match: ${bold(hit.title)}`,
    `  ${dim('│')} Source:     ${hit.sourceType ?? 'unknown'}`,
    `  ${dim('│')} Framework:  ${hit.framework}`,
    `  ${dim('│')} Match:      ${quality}${quality === 'fuzzy' ? ` (d=${hit.distance})` : ''}`,
    `  ${dim('└')} Path:       ${hit.path}`,
    '',
  ]
  if (!page.found || !page.content) {
    lines.push(page.note ?? 'Markdown not available.')
  } else {
    lines.push(page.content)
  }
  return lines.join('\n')
}

export function formatLookup(result) {
  if (!result.found) {
    return `Not found: ${result.path}`
  }
  if (!result.content) {
    const lines = []
    const m = result.metadata
    if (m) {
      lines.push(bold(m.title))
      if (m.roleHeading) lines.push(dim(m.roleHeading))
      if (m.framework) lines.push(`Framework: ${m.framework}`)
      if (m.abstract) lines.push(`\n${m.abstract}`)
      if (m.declaration) lines.push(`\n${dim('Declaration:')} ${m.declaration}`)
      if (m.platforms?.length) lines.push(`Platforms: ${m.platforms.map(p => `${p.name} ${p.introducedAt ?? ''}`).join(', ')}`)
      lines.push('')
    }
    if (result.tierLimitation) {
      lines.push(dim(`[${result.tierLimitation.tier} tier] ${result.tierLimitation.reason}`))
      lines.push(dim(`Upgrade: ${result.tierLimitation.upgrade}`))
    } else {
      lines.push(result.note ?? 'Markdown not available.')
    }
    return lines.join('\n')
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
    caps.push(`search: yes`)
    caps.push(`fuzzy: ${c.searchTrigram ? 'yes' : 'no'}`)
    caps.push(`body: ${c.searchBody ? 'yes' : 'no'}`)
    caps.push(`read: ${c.readContent ? 'yes' : 'metadata only'}`)
    lines.push(`  Capabilities:    ${caps.join(', ')}`)
    if (result.tier === 'lite') {
      lines.push(dim("  Hint:            Run 'apple-docs setup --tier standard --force' to upgrade"))
    }
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

  if (result.orphanRelsCleaned > 0) {
    lines.push(`  Orphan rels:     ${result.orphanRelsCleaned} removed`)
  }

  if (result.minified > 0) {
    lines.push(`  Minified:        ${result.minified} JSON files (saved ${formatBytes(result.minifySaved)})`)
  }

  if (result.snapshotVerification) {
    const sv = result.snapshotVerification
    lines.push('')
    if (!sv.installed) {
      lines.push(`  Snapshot:        ${sv.message}`)
    } else {
      lines.push(bold('  Snapshot Verification'))
      lines.push(`    Tier:          ${sv.tier}`)
      lines.push(`    Tag:           ${sv.tag ?? 'unknown'}`)
      lines.push(`    Installed:     ${sv.installedAt ?? 'unknown'}`)
      for (const c of sv.checks) {
        const icon = c.ok ? 'ok' : 'FAIL'
        const detail = c.ok ? '' : ` (expected ${c.expected}, got ${c.actual})`
        lines.push(`    ${c.name}: ${icon}${detail}`)
      }
      lines.push(`    Overall:       ${sv.ok ? 'healthy' : 'issues found'}`)
    }
  }

  if (result.corpusIntegrity) {
    const ci = result.corpusIntegrity
    lines.push('')
    lines.push(bold('  Corpus Integrity'))
    for (const c of ci.checks) {
      const icon = c.ok ? 'ok' : 'FAIL'
      lines.push(`    ${c.name}: ${icon}${c.detail ? ` (${c.detail})` : ''}`)
    }
    lines.push(`    Overall:       ${ci.allOk ? 'healthy' : 'issues found'}`)
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

export function formatSnapshot(result) {
  return [
    bold('Snapshot built'),
    `  Tier:       ${result.tier}`,
    `  Tag:        ${result.tag}`,
    `  Documents:  ${result.documentCount}`,
    `  DB size:    ${formatBytes(result.dbSize)}`,
    `  Archive:    ${result.archivePath} (${formatBytes(result.archiveSize)})`,
    `  Checksum:   ${result.archiveChecksum.slice(0, 16)}...`,
  ].join('\n')
}

export function formatSetup(result) {
  if (result.status === 'exists') {
    const lines = [`Corpus already exists at ${result.dataDir} (${result.pages} pages)`]
    if (result.hint) lines.push(dim(result.hint))
    else lines.push('Use --force to overwrite.')
    return lines.join('\n')
  }
  const lines = [
    bold('Setup complete'),
    `  Tag:         ${result.tag}`,
    `  Tier:        ${result.tier}`,
    `  Documents:   ${result.documentCount}`,
    `  Data dir:    ${result.dataDir}`,
  ]
  if (result.transition) {
    lines.push(`  Upgraded:    ${result.transition.from} → ${result.transition.to}`)
  }
  lines.push('', 'Run `apple-docs search <query>` to start searching.')
  return lines.join('\n')
}

export function formatIndex(result) {
  if (result.status === 'error') {
    return result.message
  }
  if (result.status === 'ok' && result.total === undefined) {
    return `${bold('Index rebuilt')}\n  Indexed:  ${result.indexed} entries`
  }
  return [
    bold('Index complete'),
    `  Indexed:  ${result.indexed} pages`,
    `  Total:    ${result.total}`,
    `  Errors:   ${result.errors}`,
  ].join('\n')
}

export function formatStorageStats(result) {
  const lines = [
    bold('Storage Breakdown'),
    `  Database:     ${formatBytes(result.database.size)}`,
    `  Raw JSON:     ${formatBytes(result.rawJson.size)} (${result.rawJson.files} files)`,
    `  Markdown:     ${formatBytes(result.markdown.size)} (${result.markdown.files} files)`,
    `  HTML cache:   ${formatBytes(result.html.size)} (${result.html.files} files)`,
    `  Total:        ${formatBytes(result.total)}`,
    '',
    bold('Table Row Counts'),
  ]
  for (const [table, count] of Object.entries(result.tables)) {
    lines.push(`  ${table}: ${count}`)
  }
  return lines.join('\n')
}

export function formatStorageGc(result) {
  const lines = [bold('Garbage Collection')]
  if (result.droppedDirs.length > 0) {
    lines.push(`  Dropped:   ${result.droppedDirs.join(', ')}`)
  }
  lines.push(`  Orphans:   ${result.orphansCleaned} removed`)
  lines.push(`  Vacuumed:  ${result.vacuumed ? 'yes' : 'no'}`)
  return lines.join('\n')
}

export function formatStorageMaterialize(result) {
  return [
    bold('Materialize complete'),
    `  Format:       ${result.format}`,
    `  Materialized: ${result.materialized} documents`,
  ].join('\n')
}

export function formatWebBuild(result) {
  return [
    bold('Static site built'),
    `  Pages:       ${result.pagesBuilt}`,
    `  Frameworks:  ${result.frameworksBuilt}`,
    `  Output:      ${result.outputDir}`,
    `  Duration:    ${(result.durationMs / 1000).toFixed(1)}s`,
  ].join('\n')
}

export function formatWebDeploy(result) {
  const lines = [bold(`Deploy to ${result.platform}`), '']
  for (const step of result.instructions) {
    lines.push(`  ${step}`)
  }
  return lines.join('\n')
}

export function formatStorageProfile(result) {
  if (result.action === 'set') {
    return [
      bold(`Storage profile set to: ${result.name}`),
      `  ${result.config.description}`,
    ].join('\n')
  }
  if (result.action === 'list') {
    const lines = [bold('Available Storage Profiles')]
    for (const p of result.profiles) {
      lines.push(`  ${bold(p.name)}`)
      lines.push(`    ${p.description}`)
      lines.push(`    Persist markdown: ${p.persistMarkdown}, HTML: ${p.persistHtml}, Cache on read: ${p.cacheOnRead}`)
      lines.push('')
    }
    return lines.join('\n')
  }
  return [
    bold(`Current profile: ${result.name}`),
    `  ${result.config.description}`,
    `  Persist markdown: ${result.config.persistMarkdown}`,
    `  Persist HTML: ${result.config.persistHtml}`,
    `  Cache on read: ${result.config.cacheOnRead}`,
  ].join('\n')
}

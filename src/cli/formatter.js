const isTTY = process.stdout.isTTY

const bold = (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s
const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s

function formatBytes(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} B`
}

const RELAXED_QUALITIES = new Set(['relaxed', 'relaxed-or', 'relaxed-token'])

function qualityBadge(quality, distance) {
  if (quality === 'match') return ''
  if (quality === 'fuzzy') return dim(` [fuzzy d=${distance}]`)
  if (RELAXED_QUALITIES.has(quality)) return dim(' [relaxed]')
  return dim(` [${quality}]`)
}

export function formatSearchResults(result) {
  if (result.results.length === 0) {
    return `No results for "${result.query}"`
  }

  const lines = []
  if (result.relaxed) {
    lines.push(dim('Showing best-effort matches (query relaxed).'))
    lines.push('')
  }
  for (const r of result.results) {
    const quality = r.matchQuality ?? 'match'
    const tag = qualityBadge(quality, r.distance)
    const sourceLabel = r.sourceType ? `${r.sourceType} / ` : ''
    const flags = [
      r.isDeprecated ? dim('[deprecated]') : '',
      r.isBeta ? dim('[beta]') : '',
    ].filter(Boolean).join(' ')
    lines.push(`  ${dim(`${sourceLabel + r.framework} / ${r.kind ?? ''}`)}${tag}${flags ? ' ' + flags : ''}`)
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
  if (page.pageInfo) {
    lines.push('')
    lines.push(dim(`--- Page ${page.pageInfo.page}/${page.pageInfo.totalPages} (${page.pageInfo.strategy}) ---`))
    if (page.pageInfo.hasNextPage) {
      lines.push(dim(`Next page: add --page ${page.pageInfo.page + 1}`))
    }
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
      const lookupFlags = [
        m.isDeprecated ? dim('[deprecated]') : '',
        m.isBeta ? dim('[beta]') : '',
      ].filter(Boolean).join(' ')
      if (lookupFlags) lines.push(lookupFlags)
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
  const lines = [result.content]
  if (result.pageInfo) {
    lines.push('')
    lines.push(dim(`--- Page ${result.pageInfo.page}/${result.pageInfo.totalPages} (${result.pageInfo.strategy}) ---`))
    if (result.pageInfo.hasNextPage) {
      lines.push(dim(`Next page: add --page ${result.pageInfo.page + 1}`))
    }
  }
  return lines.join('\n')
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

export function formatTaxonomy(result) {
  const sections = result.field && result.values
    ? [[result.field, result.values]]
    : Object.entries(result)
  const lines = []
  for (const [label, values] of sections) {
    if (!Array.isArray(values) || values.length === 0) continue
    lines.push(bold(`${label} (${values.length})`))
    for (const row of values) {
      lines.push(`  ${row.value} ${dim(`(${row.count})`)}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
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
      lines.push(dim("  Hint:            Run 'apple-docs setup --tier full --force' to upgrade"))
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
    const tierRank = { lite: 0, standard: 1, full: 2 }
    const label = tierRank[result.transition.to] >= tierRank[result.transition.from] ? 'Upgraded' : 'Downgraded'
    lines.push(`  ${label}:   ${result.transition.from} → ${result.transition.to}`)
  }
  lines.push('', 'Run `apple-docs search <query>` to start searching.')
  return lines.join('\n')
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

export function formatWebBuild(result) {
  const lines = [
    bold('Static site built'),
    `  Pages built:   ${result.pagesBuilt}`,
  ]
  if (result.pagesSkipped) lines.push(`  Pages skipped: ${result.pagesSkipped}`)
  if (result.pagesFailed) lines.push(`  Pages failed:  ${result.pagesFailed}`)
  lines.push(
    `  Frameworks:    ${result.frameworksBuilt}`,
    `  Output:        ${result.outputDir}`,
    `  Duration:      ${(result.durationMs / 1000).toFixed(1)}s`,
  )
  if (result.linksAudit) {
    const a = result.linksAudit
    const ok = a.byCategory?.internal_ok ?? 0
    const broken = a.byCategory?.internal_broken ?? 0
    const externalResolvable = a.byCategory?.external_resolvable ?? 0
    const relativeBroken = a.byCategory?.relative_broken ?? 0
    lines.push(
      `  Links:         ${a.linksTotal?.toLocaleString('en-US') ?? 0} total · ` +
      `${ok.toLocaleString('en-US')} ok, ${broken.toLocaleString('en-US')} broken, ` +
      `${externalResolvable.toLocaleString('en-US')} external_resolvable, ${relativeBroken.toLocaleString('en-US')} relative_broken`,
    )
  }
  return lines.join('\n')
}

export function formatWebDeploy(result) {
  const lines = [bold(`Deploy to ${result.platform}`), '']
  for (const step of result.instructions) {
    lines.push(`  ${step}`)
  }
  return lines.join('\n')
}


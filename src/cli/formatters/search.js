import { bold, dim, qualityBadge } from './_shared.js'

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
    lines.push(`  ${dim(`${sourceLabel + r.framework} / ${r.kind ?? ''}`)}${tag}${flags ? ` ${flags}` : ''}`)
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


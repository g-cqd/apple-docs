import { bold, dim, } from './_shared.js'

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


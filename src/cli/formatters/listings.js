import { bold, dim, } from './_shared.js'

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


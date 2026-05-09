import { bold, dim, } from './_shared.js'

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


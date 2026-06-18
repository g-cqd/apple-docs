// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { bold, dim } from './_shared.js'

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
    `  Snapshot:    ${result.tier}`,
    `  Documents:   ${result.documentCount}`,
    ...(result.storageProfile ? [`  Profile:     ${result.storageProfile}`] : []),
    `  Data dir:    ${result.dataDir}`,
  ]
  if (result.transition) {
    lines.push(`  Replaced:   ${result.transition.from} -> ${result.transition.to}`)
  }
  lines.push('', 'Run `apple-docs search <query>` to start searching.')
  return lines.join('\n')
}

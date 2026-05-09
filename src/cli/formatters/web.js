import { bold, } from './_shared.js'

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


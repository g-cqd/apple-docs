import { bold, formatBytes, } from './_shared.js'

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


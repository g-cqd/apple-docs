// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
// CLI `--json` projection dispatcher: maps each command to its
// public-output projection in src/output/projection.js. Anything not
// listed here passes through unprojected — those commands either don't
// surface query data (sync, setup, snapshot, web-deploy) or their
// formatters already operate on operator-facing payloads (storage,
// web-build).

import { projectBrowse, projectFrameworks, projectReadDoc, projectSearchResult, projectStatus, projectTaxonomy } from '../output/projection.js'

export function jsonProject(command, result, flags) {
  switch (command) {
    case 'search':
      // `search --read` returns a doc-shaped { hit, page } envelope;
      // project the page through projectReadDoc and the hit through the
      // standard search-hit projection.
      return flags.read && result?.page ? { hit: projectHit(result.hit), page: projectReadDoc(result.page, { full: true }) } : projectSearchResult(result)
    case 'read':
      return projectReadDoc(result, { full: true })
    case 'frameworks':
      return projectFrameworks(result)
    case 'browse':
      return projectBrowse(result)
    case 'kinds':
      return projectTaxonomy(result)
    case 'status':
      return projectStatus(result, { advanced: !!flags.advanced })
    default:
      return result
  }
}

function projectHit(hit) {
  if (!hit) return hit
  return projectSearchResult({ results: [hit] }).results[0]
}

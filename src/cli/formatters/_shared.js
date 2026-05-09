/**
 * Shared CLI formatter helpers (TTY detection, bytes formatter, search
 * quality badge). Pulled out so per-output-kind formatters can share
 * without re-importing the whole module surface.
 */

export const isTTY = process.stdout.isTTY

export const bold = (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s
export const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s

export function formatBytes(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} B`
}

export const RELAXED_QUALITIES = new Set(['relaxed', 'relaxed-or', 'relaxed-token'])

export function qualityBadge(quality, distance) {
  if (quality === 'match') return ''
  if (quality === 'fuzzy') return dim(` [fuzzy d=${distance}]`)
  if (RELAXED_QUALITIES.has(quality)) return dim(' [relaxed]')
  return dim(` [${quality}]`)
}

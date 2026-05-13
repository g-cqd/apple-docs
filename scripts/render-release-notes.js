#!/usr/bin/env bun
/**
 * Render the GitHub release body from a snapshot build's `status.json`.
 *
 * Lives in its own file because the previous heredoc invocation
 * (`bun run --silent <<EOF ... EOF`) hit a stdin-handling quirk and
 * printed bun's CLI help into release-body.md instead of the rendered
 * markdown. `bun scripts/render-release-notes.js > body.md` avoids the
 * stdin path entirely.
 *
 * Usage:
 *   APPLE_DOCS_STATUS=dist/status.json \
 *     RELEASE_PROLOGUE='Manual snapshot build.' \
 *     bun scripts/render-release-notes.js > dist/release-body.md
 */

const statusPath = process.env.APPLE_DOCS_STATUS ?? 'dist/status.json'
const prologue = process.env.RELEASE_PROLOGUE ?? 'Snapshot build.'

const status = await Bun.file(statusPath).json()

function fmtBytes(n) {
  if (!Number.isFinite(n)) return 'n/a'
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n > 1e3) return `${(n / 1e3).toFixed(1)} KB`
  return `${n} B`
}

function shortHash(h) {
  return h ? '`' + h.slice(0, 12) + '…`' : 'n/a'
}

const archives = status.archives ?? {}
const snapshot = archives.snapshot
if (!snapshot) {
  console.error('render-release-notes: status.json is missing archives.snapshot')
  process.exit(1)
}

const rows = [
  ['Archive', 'Size', 'SHA-256'],
  ['---', '---', '---'],
  ['`' + snapshot.name + '`', fmtBytes(snapshot.size), shortHash(snapshot.sha256)],
]
const table = rows.map(r => '| ' + r.join(' | ') + ' |').join('\n')

const body = [
  prologue,
  '',
  'Single-tier snapshot — ships the full corpus, every Apple font, and the complete pre-rendered SF Symbols matrix in one `.tar.gz`.',
  '',
  '## Artifact',
  '',
  table,
  '',
  '## Install',
  '',
  'Snapshots are packaged as `.tar.gz` with `gzip -9`. Stock `tar` extracts them on every supported platform — no extra tooling required:',
  '',
  '```bash',
  'apple-docs setup',
  '```',
].join('\n')

process.stdout.write(body)

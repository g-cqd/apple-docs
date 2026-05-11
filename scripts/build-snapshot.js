#!/usr/bin/env bun
/**
 * Build a snapshot archive from the current corpus. Internal helper for the
 * `Build Snapshots` GitHub Actions workflow — not part of the public CLI
 * surface. Args: --out <dir>, --tag <name>, --allow-incomplete-symbols.
 *
 * Snapshots ship in a single shape; --tier is not a supported flag.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { DocsDatabase } from '../src/storage/database.js'
import { snapshotBuild } from '../src/commands/snapshot.js'
import { createLogger } from '../src/lib/logger.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

const args = parseArgs(process.argv)
const dataDir = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const logger = createLogger('info')
const db = new DocsDatabase(join(dataDir, 'apple-docs.db'))

if (args.tier && args.tier !== 'full') {
  console.error(`build-snapshot: --tier ${args.tier} is not a supported flag.`)
  process.exit(2)
}

try {
  const result = await snapshotBuild(
    {
      out: args.out ?? 'dist',
      tag: args.tag,
      allowIncompleteSymbols: args['allow-incomplete-symbols'] === true || args['allow-incomplete-symbols'] === 'true',
    },
    { db, dataDir, logger },
  )
  console.log(JSON.stringify(result, null, 2))
} finally {
  db.close()
}

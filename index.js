#!/usr/bin/env bun
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { DocsDatabase } from './src/storage/database.js'
import { createLogger } from './src/lib/logger.js'
import { startServer } from './src/mcp/server.js'

const dataDir = process.env.APPLE_DOCS_HOME
if (!dataDir) {
  process.stderr.write('Error: APPLE_DOCS_HOME environment variable is required.\n')
  process.stderr.write('Set it to the path of your apple-docs data directory.\n')
  process.stderr.write('Populate it first with: apple-docs sync --home /path/to/data\n\n')
  process.stderr.write('Example MCP config:\n')
  process.stderr.write(`${JSON.stringify({
    mcpServers: {
      'apple-docs': {
        command: 'bun',
        args: ['run', import.meta.path],
        env: { APPLE_DOCS_HOME: '/path/to/apple-docs-data' },
      },
    },
  }, null, 2)}\n`)
  process.exit(1)
}

const dbPath = join(dataDir, 'apple-docs.db')
if (!existsSync(dbPath)) {
  process.stderr.write(`Error: Database not found at ${dbPath}\n`)
  process.stderr.write(`Run "apple-docs sync --home ${dataDir}" first to populate the corpus.\n`)
  process.exit(1)
}

const logger = createLogger(process.env.APPLE_DOCS_LOG_LEVEL ?? 'warn')
const db = new DocsDatabase(dbPath)
const ctx = { db, dataDir, logger }

const cleanup = () => { try { db.close() } catch {} }
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

try {
  await startServer(ctx)
} finally {
  cleanup()
}

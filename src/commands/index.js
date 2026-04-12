import { indexBodyFull, indexBodyIncremental } from '../pipeline/index-body.js'

/**
 * Build or update the full-body search index.
 * @param {{ full?: boolean }} opts
 * @param {{ db, dataDir, logger }} ctx
 */
export async function index(opts, ctx) {
  const { db, dataDir, logger } = ctx

  db.setActivity('index')

  try {
    const hasIndex = db.getBodyIndexCount() > 0
    let result

    if (opts.full || !hasIndex) {
      result = await indexBodyFull(db, dataDir, logger, (p) => {
        ctx.onProgress?.({ phase: 'index', ...p })
      })
    } else {
      result = await indexBodyIncremental(db, dataDir, logger, (p) => {
        ctx.onProgress?.({ phase: 'index', ...p })
      })
    }

    return result
  } finally {
    db.clearActivity()
  }
}

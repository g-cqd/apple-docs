import { ensureNormalizedDocument } from '../content/hydrate.js'
import { renderPlainText } from '../content/render-text.js'

/**
 * Index all document bodies into documents_body_fts.
 * Clears existing index and rebuilds from scratch.
 */
export async function indexBodyFull(db, dataDir, logger, onProgress) {
  return indexNormalizedBody(db, dataDir, logger, null, onProgress)
}

/**
 * Index only documents updated after the last body index build.
 *
 * If an interrupted FULL rebuild left its checkpoint behind, resume it
 * instead: the full run already cleared the FTS table up front, so an
 * incremental pass over `updated_at` would leave the index mostly empty
 * while reporting success.
 */
export async function indexBodyIncremental(db, dataDir, logger, onProgress) {
  if (db.getSyncCheckpoint('body-index:full')) {
    logger.info('Resuming interrupted full body index build...')
    return indexNormalizedBody(db, dataDir, logger, null, onProgress)
  }
  const lastIndexed = db.db.query("SELECT value FROM schema_meta WHERE key = 'body_indexed_at'").get()?.value ?? null
  return indexNormalizedBody(db, dataDir, logger, lastIndexed, onProgress)
}

async function indexNormalizedBody(db, dataDir, logger, since, onProgress) {
  if (!db.hasTable('document_sections')) {
    logger.info('document_sections table not available (lite tier) — cannot build body index')
    return { indexed: 0, total: 0, errors: 0 }
  }

  // Stamp with the scan's START time, not completion: a document upserted
  // while the id-ordered scan is past its id would otherwise carry an
  // updated_at earlier than a completion-time stamp and be skipped by every
  // future incremental run.
  const checkpointKey = since ? 'body-index:incremental' : 'body-index:full'
  const checkpoint = db.getSyncCheckpoint(checkpointKey)
  const scanStartedAt = checkpoint?.scanStartedAt ?? new Date().toISOString()
  const resumeSince = checkpoint?.since ?? since
  const total = checkpoint?.total ?? db.db.query(
    resumeSince
      ? 'SELECT COUNT(*) as c FROM documents WHERE updated_at > ?'
      : 'SELECT COUNT(*) as c FROM documents'
  ).get(...(resumeSince ? [resumeSince] : [])).c

  if (total === 0) {
    logger.info(resumeSince ? 'Body index is up to date' : 'No normalized documents to index')
    db.clearSyncCheckpoint(checkpointKey)
    return { indexed: 0, total: 0, errors: 0 }
  }

  let indexed = checkpoint?.indexed ?? 0
  let errors = checkpoint?.errors ?? 0
  let lastDocumentId = checkpoint?.lastDocumentId ?? 0
  const batchSize = 500

  logger.info(
    checkpoint
      ? `Resuming normalized body index at ${indexed}/${total} documents...`
      : `${resumeSince ? 'Updating' : 'Building'} normalized body index for ${total} documents...`
  )

  if (!resumeSince && !checkpoint) {
    db.clearBodyIndex()
  }

  while (true) {
    const documents = resumeSince
      ? db.db.query(`
        SELECT id, key, title, abstract_text, declaration_text, headings, source_type
        FROM documents
        WHERE updated_at > ? AND id > ?
        ORDER BY id
        LIMIT ?
      `).all(resumeSince, lastDocumentId, batchSize)
      : db.db.query(`
        SELECT id, key, title, abstract_text, declaration_text, headings, source_type
        FROM documents
        WHERE id > ?
        ORDER BY id
        LIMIT ?
      `).all(lastDocumentId, batchSize)

    if (documents.length === 0) break

    // One batched IN(...) query per 500-doc page instead of one query per
    // document (373k statement executions on a full rebuild otherwise).
    const sectionsByDocId = db.getSectionsByDocumentIds(documents.map(d => d.id))

    const inserts = []
    const staleDeletes = []
    for (const document of documents) {
      try {
        let sections = sectionsByDocId.get(document.id) ?? []

        if (sections.length === 0) {
          await ensureNormalizedDocument(db, dataDir, document.key, document.source_type ?? 'apple-docc')
          sections = db.getDocumentSections(document.key)
        }

        const body = renderPlainText(document, sections)
        if (body.length > 0) {
          inserts.push({ id: document.id, body })
          indexed++
        } else if (since) {
          // A changed document whose new body renders empty must drop its
          // stale FTS row, or the old body keeps matching forever.
          staleDeletes.push(document.id)
        }
      } catch {
        errors++
      }
      lastDocumentId = document.id
    }

    if (inserts.length > 0 || staleDeletes.length > 0) {
      db.db.run('BEGIN')
      try {
        for (const insert of inserts) {
          db.insertBody(insert.id, insert.body)
        }
        for (const id of staleDeletes) {
          db.search.deleteBodyByDocId(id)
        }
        db.db.run('COMMIT')
      } catch (error) {
        db.db.run('ROLLBACK')
        throw error
      }
    }

    db.setSyncCheckpoint(checkpointKey, {
      since: resumeSince,
      total,
      indexed,
      errors,
      lastDocumentId,
      scanStartedAt,
    })

    onProgress?.({ indexed, total, errors, resumed: !!checkpoint, lastDocumentId })
    if (indexed % 5000 === 0 || documents.length < batchSize) {
      logger.info(`Indexed ${indexed}/${total} documents...`)
    }
  }

  db.db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('body_indexed_at', ?)", [scanStartedAt])
  db.clearSyncCheckpoint(checkpointKey)
  logger.info(`Body index complete: ${indexed} documents indexed, ${errors} errors`)
  return { indexed, total, errors }
}

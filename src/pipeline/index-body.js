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
 */
export async function indexBodyIncremental(db, dataDir, logger, onProgress) {
  const lastIndexed = db.db.query("SELECT value FROM schema_meta WHERE key = 'body_indexed_at'").get()?.value ?? null
  return indexNormalizedBody(db, dataDir, logger, lastIndexed, onProgress)
}

async function indexNormalizedBody(db, dataDir, logger, since, onProgress) {
  if (!db.hasTable('document_sections')) {
    logger.info('document_sections table not available (lite tier) — cannot build body index')
    return { indexed: 0, total: 0, errors: 0 }
  }

  const checkpointKey = since ? 'body-index:incremental' : 'body-index:full'
  const checkpoint = db.getSyncCheckpoint(checkpointKey)
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

    const inserts = []
    for (const document of documents) {
      try {
        let sections = db.db.query(`
          SELECT section_kind, heading, content_text, content_json, sort_order
          FROM document_sections
          WHERE document_id = ?
          ORDER BY sort_order, id
        `).all(document.id).map(section => ({
          sectionKind: section.section_kind,
          heading: section.heading,
          contentText: section.content_text,
          contentJson: section.content_json,
          sortOrder: section.sort_order,
        }))

        if (sections.length === 0) {
          await ensureNormalizedDocument(db, dataDir, document.key, document.source_type ?? 'apple-docc')
          sections = db.getDocumentSections(document.key)
        }

        const body = renderPlainText(document, sections)
        if (body.length > 0) {
          inserts.push({ id: document.id, body })
          indexed++
        }
      } catch {
        errors++
      }
      lastDocumentId = document.id
    }

    if (inserts.length > 0) {
      db.db.run('BEGIN')
      try {
        for (const insert of inserts) {
          db.insertBody(insert.id, insert.body)
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
    })

    onProgress?.({ indexed, total, errors, resumed: !!checkpoint, lastDocumentId })
    if (indexed % 5000 === 0 || documents.length < batchSize) {
      logger.info(`Indexed ${indexed}/${total} documents...`)
    }
  }

  db.db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('body_indexed_at', ?)", [new Date().toISOString()])
  db.clearSyncCheckpoint(checkpointKey)
  logger.info(`Body index complete: ${indexed} documents indexed, ${errors} errors`)
  return { indexed, total, errors }
}

import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { sha256 } from '../../lib/hash.js'
import { spawnWithDeadline } from '../../lib/spawn-with-deadline.js'
import { fileCount } from '../../storage/files.js'
import { resolveArchivePath } from './helpers.js'
import { validateArchive } from './validate-archive.js'

/**
 * Install a standalone raw-json pack (built by `snapshot build-raw-json-pack`)
 * into `dataDir/raw-json`. Opt-in: reading and search work entirely from the
 * DB's document_sections, so raw-json is only needed to re-normalize locally
 * (consolidate / hydrate) after a renderer change.
 *
 * Local archives only for now (path must live under $HOME / cwd, same as
 * `setup --archive`). Verifies a sibling `.sha256` when present.
 *
 * @param {{ archive?: string|null }} opts
 * @param {{ dataDir, logger }} ctx
 */
export async function setupRawJson(opts, ctx) {
  const { dataDir, logger } = ctx
  if (!opts.archive) {
    throw new ValidationError(
      'apple-docs setup raw-json requires --archive <path> to a pack built by `apple-docs snapshot build-raw-json-pack`.',
      { field: 'archive' },
    )
  }
  const archivePath = resolveArchivePath(opts.archive)
  if (!existsSync(archivePath)) {
    throw new NotFoundError(archivePath, `raw-json pack not found: ${archivePath}`)
  }

  const checksumPath = `${archivePath}.sha256`
  if (existsSync(checksumPath)) {
    const expected = (await Bun.file(checksumPath).text()).trim().split(/\s+/)[0]
    const actual = sha256(new Uint8Array(await Bun.file(archivePath).arrayBuffer()))
    if (actual !== expected) {
      throw new ValidationError(`Checksum mismatch! Expected ${expected.slice(0, 16)}..., got ${actual.slice(0, 16)}...`, { field: 'checksum' })
    }
    logger.info('Checksum verified.')
  } else {
    logger.warn(`No .sha256 sidecar at ${checksumPath} — proceeding without checksum verification`)
  }

  logger.info(`Installing raw-json pack: ${archivePath}`)
  const validation = await validateArchive(archivePath, dataDir)
  logger.info(`Archive validated (${validation.entries.length} entries).`)

  // Replace any existing raw-json tree so a stale pack can't leak through.
  const rawJsonTarget = join(dataDir, 'raw-json')
  if (existsSync(rawJsonTarget)) rmSync(rawJsonTarget, { recursive: true, force: true })

  const { stderr, exitCode } = await spawnWithDeadline(
    ['tar', '--no-same-owner', '--no-same-permissions', '-xzf', archivePath, '-C', dataDir],
    { deadlineMs: 10 * 60_000 },
  )
  if (exitCode !== 0) throw new ValidationError(`raw-json pack extraction failed (exit ${exitCode}): ${stderr}`)

  const files = fileCount(rawJsonTarget)
  logger.info(`raw-json pack installed (${files} files).`)
  return { status: 'ok', kind: 'raw-json-pack', archive: archivePath, files, dataDir }
}

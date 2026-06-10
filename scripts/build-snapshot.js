#!/usr/bin/env bun
/**
 * Orchestrator for the snapshot release pipeline.
 *
 * Produces, in order, into `--out`:
 *
 *   1. `apple-docs-full-<tag>.7z`        — full corpus (DB + raw JSON +
 *                                          markdown + symbols + fonts).
 *   2. `symbols-<tag>.7z`                — combined SF Symbols pre-renders.
 *   3. `fonts-all-<tag>.7z`              — all extracted fonts.
 *   4. `fonts-<family>-<tag>.7z` × N     — one per family.
 *
 * Every archive has a sibling `.7z.sha256` written by the shared archive
 * helper.
 *
 * Also emits a unified `status.json` (or merges into one supplied via
 * `--status-in`) with an `archives` field that disclose every artefact
 * name + size + sha256 + (optional) URL. The workflow file passes the
 * release HTML URL prefix via `--release-url-base` so the URLs are baked
 * in at build time.
 *
 * Args:
 *   --out <dir>                 (required for full pipeline; default `dist/`)
 *   --tag <name>                (default snapshot-YYYYMMDD)
 *   --allow-incomplete-symbols  (passthrough for snapshotBuild)
 *   --status-in <path>          (optional; merge archives map into this file)
 *   --status-out <path>         (optional; defaults to <out>/status.json)
 *   --release-url-base <url>    (optional; prefix for archive URLs in status)
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../src/storage/database.js'
import { snapshotBuild } from '../src/commands/snapshot.js'
import { ensureFontsExtracted } from '../src/resources/apple-assets.js'
import { createLogger } from '../src/lib/logger.js'
import { ensureDir, readJSON, writeJSON } from '../src/storage/files.js'
import { buildSymbolsArchive } from './build-symbols-archive.js'
import { buildFontsArchives, FONT_FAMILIES } from './build-fonts-archives.js'

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
const outDir = args.out ?? 'dist'
const tag = args.tag ?? `snapshot-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
// Optional non-default embedder. Selects the registry model for both the index
// build (env → search/embedder.js) and the artifact name (a separate
// `apple-docs-full-<model>-<tag>` variant). Omitted ⇒ the default potion build.
const embedModel = typeof args['embed-model'] === 'string' ? args['embed-model'] : null
if (embedModel) process.env.APPLE_DOCS_EMBED_MODEL = embedModel
if (!/^[a-z0-9._-]{1,64}$/i.test(tag)) {
  console.error(`build-snapshot: invalid --tag "${tag}"`)
  process.exit(2)
}
const logger = createLogger('info')
const db = new DocsDatabase(join(dataDir, 'apple-docs.db'))

if (args.tier && args.tier !== 'full') {
  console.error(`build-snapshot: --tier ${args.tier} is not a supported flag.`)
  process.exit(2)
}

ensureDir(outDir)

try {
  // 0. Ship the offline embedding model — NOT the vectors. Snapshots carry no
  //    document_chunks/document_vectors rows (snapshotBuild strips them; they
  //    are ~0.5 GB of incompressible codes against GitHub's 2 GiB asset
  //    ceiling); `apple-docs setup` rebuilds them locally from the shipped
  //    sections + this model. With APPLE_DOCS_ALLOW_REMOTE_MODELS=1 (CI) the
  //    model files are fetched on first use, probe-run, and sha256-verified
  //    against the pins in src/search/model-integrity.js. A pin mismatch or a
  //    missing model ABORTS a release build (fail closed — a model-less
  //    snapshot would strand every consumer lexical-only); ad-hoc local builds
  //    without the remote flag degrade to a skip.
  process.env.APPLE_DOCS_MODELS_DIR ??= join(dataDir, 'resources', 'models')
  const { ensureEmbeddingModel } = await import('../src/search/model-integrity.js')
  const modelCheck = await ensureEmbeddingModel({ logger })
  logger.info(
    modelCheck.status === 'ok'
      ? `Embedding model verified: ${modelCheck.hfId} (${modelCheck.verified} files pinned)`
      : `Embedding model skipped (lexical-only consumers): ${modelCheck.message}`,
  )

  // 0b. Determinism guard for fonts. The workflow runs this orchestrator
  //     twice against the SAME dataDir (dist/ then dist-check/) and sha-diffs
  //     the archives. If a font family failed to extract during `sync` (a
  //     flaky SLA/multi-volume DMG mount), its absence would either differ
  //     between the two passes or ship an incomplete font set. ensureFontsExtracted
  //     re-extracts any missing family from the cached original/<id>.dmg using
  //     the hardened `-plist` mount; idempotent, so the dist-check pass sees
  //     the now-complete set and skips. Both passes stage an identical tree.
  try {
    const repaired = await ensureFontsExtracted(dataDir, logger)
    if (repaired.families.length) {
      logger.info(`Fonts: re-extracted ${repaired.extracted} file(s) for ${repaired.families.join(', ')}`)
    }
  } catch (err) {
    logger.warn(`Font determinism guard failed (continuing): ${err.message}`)
  }

  // 1. Full snapshot (.tar.zst, zstd -9; replaces the old .tar.gz path).
  const snapshot = await snapshotBuild(
    {
      out: outDir,
      tag,
      embedModel,
      allowIncompleteSymbols:
        args['allow-incomplete-symbols'] === true || args['allow-incomplete-symbols'] === 'true',
    },
    { db, dataDir, logger },
  )

  // 1b. Asset-size guard: GitHub releases hard-reject files ≥ 2 GiB. Fail
  //     here, with the levers, instead of a cryptic 422 at upload time.
  const SIZE_CEILING_BYTES = Math.floor(1.9 * 1024 ** 3)
  if (snapshot.archiveSize > SIZE_CEILING_BYTES) {
    throw new Error(
      `Snapshot ${snapshot.archiveName} is ${(snapshot.archiveSize / 1024 ** 3).toFixed(2)} GiB — over the 1.9 GiB guard ` +
      '(GitHub asset ceiling is 2 GiB). Levers: prune corpus sources, drop document_raw from the artifact, or split assets.',
    )
  }

  // 2. Combined symbols archive (additive disclosure — does not replace the
  //    symbols included in the full snapshot; it's a smaller, focused asset
  //    for consumers who only want pre-renders).
  const symbols = await buildSymbolsArchive({ dataDir, outDir, tag, logger })

  // 3. Per-family + combined fonts archives.
  const fonts = await buildFontsArchives({ dataDir, outDir, tag, logger })

  // 4. Build the `archives` block for status.json. URLs are derived from
  //    --release-url-base (e.g. `https://github.com/g-cqd/apple-docs/releases/download/<tag>`).
  const urlBase = typeof args['release-url-base'] === 'string'
    ? args['release-url-base'].replace(/\/+$/, '')
    : null
  const url = (name) => urlBase ? `${urlBase}/${name}` : null

  const archives = {
    snapshot: {
      name: snapshot.archiveName,
      sha256: snapshot.archiveChecksum,
      size: snapshot.archiveSize,
      url: url(snapshot.archiveName),
    },
    symbols: symbols
      ? { name: symbols.name, sha256: symbols.sha256, size: symbols.size, url: url(symbols.name) }
      : null,
    fonts_all: fonts.all
      ? { name: fonts.all.name, sha256: fonts.all.sha256, size: fonts.all.size, url: url(fonts.all.name) }
      : null,
    fonts_by_family: Object.fromEntries(
      FONT_FAMILIES
        .filter(f => fonts.byFamily[f])
        .map(f => [f, {
          name: fonts.byFamily[f].name,
          sha256: fonts.byFamily[f].sha256,
          size: fonts.byFamily[f].size,
          url: url(fonts.byFamily[f].name),
        }]),
    ),
  }

  // 5. Status.json — merge into an upstream `apple-docs status --json` blob
  //    when --status-in is given, else write a minimal archives-only doc.
  let statusDoc = {}
  if (args['status-in']) {
    if (!existsSync(args['status-in'])) {
      console.error(`build-snapshot: --status-in ${args['status-in']} not found`)
      process.exit(2)
    }
    statusDoc = (await readJSON(args['status-in'])) ?? {}
  }
  statusDoc.tag = tag
  statusDoc.archives = archives
  // Build-host macOS provenance — the beta update channel reads this tiny
  // asset to decide whether a stable release can supersede a beta install
  // without shedding newer-OS SF Symbols.
  if (process.platform === 'darwin') {
    try {
      const v = new TextDecoder().decode(Bun.spawnSync(['sw_vers', '-productVersion']).stdout).trim()
      if (/^\d+(\.\d+)*$/.test(v)) statusDoc.buildMacos = v
    } catch {}
  }
  const statusOut = args['status-out'] ?? join(outDir, 'status.json')
  await writeJSON(statusOut, statusDoc)

  // Final report (consumed by the workflow, also human-readable on dispatch).
  console.log(JSON.stringify({
    tag,
    statusPath: statusOut,
    snapshot,
    symbols,
    fonts,
  }, null, 2))
} finally {
  db.close()
}

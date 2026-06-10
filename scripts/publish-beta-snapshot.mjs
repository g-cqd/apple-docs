#!/usr/bin/env bun
/**
 * Build a full snapshot from THIS machine's corpus and publish it to
 * GitHub as a prerelease — the beta channel.
 *
 * Why this exists: snapshots inherit the SF Symbols catalog of the
 * macOS that builds them. CI runners trail the newest macOS, so a
 * snapshot built on a developer machine running a newer (or beta) OS
 * carries symbols CI cannot produce. Those builds ship as prereleases
 * tagged `snapshot-YYYYMMDD-beta.N`; `apple-docs setup --beta` opts
 * into them.
 *
 * Flow:
 *   1. Refresh fonts + SF Symbols from the LOCAL OS (that's the point).
 *   2. `snapshot build` (stamps build_macos into the DB + manifest).
 *   3. Compose a status.json (buildMacos) + release notes.
 *   4. `gh release create --prerelease` with the archive + sidecars.
 *
 * Usage:
 *   bun scripts/publish-beta-snapshot.mjs                 # build + publish
 *   bun scripts/publish-beta-snapshot.mjs --no-publish    # build only
 *   bun scripts/publish-beta-snapshot.mjs --skip-resources  # trust current corpus
 *   bun scripts/publish-beta-snapshot.mjs --allow-incomplete-symbols
 *   bun scripts/publish-beta-snapshot.mjs --rollout gc@host  # push-update an instance
 *
 * `--rollout <ssh-host>` (default: $APPLE_DOCS_BETA_ROLLOUT) fires the
 * instance's `ops/cli.js pull-snapshot` over ssh after publishing —
 * detached on the remote, so the publisher never blocks on the install.
 * The instance must run SNAPSHOT_CHANNEL=beta to pick the prerelease up.
 *
 * Requires: a populated $APPLE_DOCS_HOME and an authenticated `gh`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../src/storage/database.js'
import { createLogger } from '../src/lib/logger.js'
import { runResourcesPhase } from '../src/commands/sync/phases.js'
import { sha256File } from '../src/lib/hash.js'

const ROOT = join(import.meta.dir, '..')
const args = new Set(process.argv.slice(2))
const flagValue = (name) => {
  const i = process.argv.indexOf(name)
  const v = i > -1 ? process.argv[i + 1] : null
  return v && !v.startsWith('--') ? v : null
}
const dataDir = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const outDir = join(ROOT, 'dist-beta')
const rolloutHost = flagValue('--rollout') ?? process.env.APPLE_DOCS_BETA_ROLLOUT ?? null
const logger = createLogger('info')

function sh(cmd, opts = {}) {
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', ...opts })
  const stdout = new TextDecoder().decode(r.stdout).trim()
  const stderr = new TextDecoder().decode(r.stderr).trim()
  if (r.exitCode !== 0 && !opts.allowFailure) {
    throw new Error(`${cmd.join(' ')} failed (${r.exitCode}): ${stderr.slice(-400)}`)
  }
  return { code: r.exitCode, stdout, stderr }
}

// --- preflight ---------------------------------------------------------------
if (!existsSync(join(dataDir, 'apple-docs.db'))) {
  console.error(`No corpus at ${dataDir} (set APPLE_DOCS_HOME). Run apple-docs setup or sync first.`)
  process.exit(2)
}
if (process.platform !== 'darwin') {
  console.error('Beta snapshots are about the local macOS symbol catalog — run this on macOS.')
  process.exit(2)
}
const macos = sh(['sw_vers', '-productVersion']).stdout
sh(['gh', 'auth', 'status'], { allowFailure: false })

// Next free beta tag for today.
const today = new Date().toISOString().slice(0, 10).replaceAll('-', '')
const existing = sh(['gh', 'release', 'list', '--limit', '50', '--json', 'tagName', '--jq', '.[].tagName']).stdout.split('\n')
let n = 1
while (existing.includes(`snapshot-${today}-beta.${n}`)) n++
const tag = `snapshot-${today}-beta.${n}`
logger.info(`Beta snapshot: ${tag} (macOS ${macos}, corpus ${dataDir})`)

// --- 1. refresh local resources ----------------------------------------------
if (!args.has('--skip-resources')) {
  logger.info('Refreshing Apple fonts + SF Symbols from the local OS…')
  const db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
  try {
    const res = await runResourcesPhase({ ctx: { db, dataDir, logger }, logger })
    for (const f of res.failedSources) logger.warn(`resource step failed: ${f.source}: ${f.error}`)
    if (res.symbolsResult) logger.info(`symbols: ${JSON.stringify(res.symbolsResult)}`)
  } finally {
    db.close()
  }
}

// --- 1b. ensure the embedding model ships --------------------------------------
// `sync` never fetches the model2vec model (only setup and the CI
// orchestrator do), so a sync-built corpus would otherwise publish a
// snapshot without it — consumers would silently degrade to
// lexical-only. Fetch + sha256-verify it into the corpus before
// archiving, exactly like scripts/build-snapshot.js does on CI.
{
  const { ensureEmbeddingModel } = await import('../src/search/model-integrity.js')
  process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS = '1'
  process.env.APPLE_DOCS_MODELS_DIR = join(dataDir, 'resources', 'models')
  const modelCheck = await ensureEmbeddingModel({ logger })
  if (modelCheck?.status !== 'ok') {
    console.error(`embedding model unavailable: ${modelCheck?.message ?? 'unknown'} — refusing to publish a lexical-only snapshot`)
    process.exit(2)
  }
  logger.info(`Embedding model ready: ${modelCheck.hfId} (${modelCheck.verified} files verified)`)
}

// --- 2. build ------------------------------------------------------------------
mkdirSync(outDir, { recursive: true })
const buildArgs = ['bun', join(ROOT, 'cli.js'), 'snapshot', 'build', '--out', outDir, '--tag', tag]
if (args.has('--allow-incomplete-symbols')) buildArgs.push('--allow-incomplete-symbols')
logger.info('Building snapshot archive (VACUUM INTO + tar.zst — several minutes)…')
const build = Bun.spawnSync(buildArgs, {
  cwd: ROOT,
  env: { ...process.env, APPLE_DOCS_HOME: dataDir },
  stdout: 'inherit',
  stderr: 'inherit',
})
if (build.exitCode !== 0) process.exit(build.exitCode)

const archive = join(outDir, `apple-docs-full-${tag}.tar.zst`)
const sidecar = `${archive}.sha256`
const manifestPath = join(outDir, `apple-docs-full-${tag}.manifest.json`)
for (const f of [archive, sidecar, manifestPath]) {
  if (!existsSync(f)) {
    console.error(`expected build output missing: ${f}`)
    process.exit(2)
  }
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

// --- 3. status.json + notes ----------------------------------------------------
const statusPath = join(outDir, 'status.json')
writeFileSync(statusPath, JSON.stringify({
  tag,
  channel: 'beta',
  buildMacos: macos,
  archives: {
    snapshot: {
      name: `apple-docs-full-${tag}.tar.zst`,
      sha256: await sha256File(archive),
      size: Bun.file(archive).size,
    },
  },
}, null, 2))

const sizeGb = (Bun.file(archive).size / 1e9).toFixed(2)
const notesPath = join(outDir, 'release-body.md')
writeFileSync(notesPath, `**Beta snapshot** — built on macOS ${macos} (CI builds on an older macOS and cannot
produce this SF Symbols catalog). Expect it to be superseded without notice.

| | |
| --- | --- |
| Documents | ${manifest.documentCount?.toLocaleString?.() ?? manifest.documentCount} |
| Archive | ${sizeGb} GB |
| Build host | macOS ${macos} |
| Schema | v${manifest.schemaVersion} |

## Install

\`\`\`bash
apple-docs setup --beta --force
\`\`\`

The beta channel updates through newer betas, or a stable snapshot whose
build host runs at least the same macOS — never a stable that would shed
symbols this build already carries.
`)

// --- 4. publish ------------------------------------------------------------------
if (args.has('--no-publish')) {
  logger.info(`Build complete (not published): ${archive}`)
  process.exit(0)
}
logger.info(`Publishing ${tag} as a prerelease (uploading ${sizeGb} GB)…`)
sh(['gh', 'release', 'create', tag,
  '--prerelease',
  '--title', `Snapshot (${tag}, macOS ${macos})`,
  '--notes-file', notesPath,
  archive, sidecar, manifestPath, statusPath,
], { stdout: 'inherit', stderr: 'inherit' })
logger.info(`Published: https://github.com/g-cqd/apple-docs/releases/tag/${tag}`)

// Push-style rollout: poke the beta-channel instance, detached on the
// remote so a ~15-minute install never blocks the publisher.
if (rolloutHost) {
  // `gh release create` returns before the /releases LIST endpoint
  // serves the new tag (observed: a trigger 2s after publish resolved
  // the PREVIOUS beta and no-opped). Wait until the list actually
  // carries it so the instance's channel resolver can see it.
  for (let attempt = 1; attempt <= 12; attempt++) {
    const listed = sh(['gh', 'api', 'repos/g-cqd/apple-docs/releases?per_page=5', '--jq', '.[].tag_name'], { allowFailure: true })
    if (listed.stdout.split('\n').includes(tag)) break
    if (attempt === 12) logger.warn(`release ${tag} still not in the list API after ~60s — triggering anyway`)
    await Bun.sleep(5000)
  }
  logger.info(`Triggering rollout on ${rolloutHost}…`)
  const remoteLog = `~/beta-rollout-${tag}.log`
  const r = sh(['ssh', '-o', 'BatchMode=yes', rolloutHost,
    `bash -lc 'cd ~/Developer/apple-docs/ops && nohup bun cli.js pull-snapshot > ${remoteLog} 2>&1 & echo triggered'`,
  ], { allowFailure: true })
  if (r.code === 0) {
    logger.info(`Rollout triggered — remote log: ${rolloutHost}:${remoteLog}`)
  } else {
    logger.warn(`Rollout trigger failed (${r.code}): ${r.stderr.slice(-200)} — the instance's autoroll will pick it up.`)
  }
}

/**
 * Dispatch table for low-frequency maintenance subcommands —
 * storage, snapshot, consolidate, index. Each entry returns
 * `{ result, formatter }` so the parent cli.js stays a thin
 * pretty-printer/JSON-emitter.
 *
 * Returns null when no entry matches; cli.js then falls through
 * to its own command switch.
 */

import { formatStorageGc, formatStorageStats } from './formatter.js'
import { showHelp } from './help.js'

/** @param {any} family */
function exitHelp(family) {
  showHelp(family)
  process.exit(1)
}

/** @param {string} label */
function summary(label) {
  return (/** @type {any} */ result) => `${label}: ${JSON.stringify(result)}`
}

/** @param {any} subcommand @param {any} positional @param {any} flags @param {any} ctx */
async function dispatchStorage(subcommand, positional, flags, ctx) {
  if (subcommand === 'stats') {
    const { storageStats } = await import('../commands/storage.js')
    return { result: await storageStats({}, ctx), formatter: formatStorageStats }
  }
  if (subcommand === 'profile') {
    const { getProfile, setProfile, getProfileConfig } = await import('../storage/profiles.js')
    const name = positional[0]
    if (name) setProfile(ctx.db, name) // throws NotFoundError on an unknown name
    const active = getProfile(ctx.db)
    return { result: { profile: active, ...getProfileConfig(active) }, formatter: summary('storage profile') }
  }
  if (subcommand === 'materialize') {
    const { storageMaterialize } = await import('../commands/storage.js')
    const format = ['html', 'raw-json'].includes(flags.format) ? flags.format : 'markdown'
    const roots = flags.roots
      ? String(flags.roots)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined
    return { result: await storageMaterialize({ format, roots }, ctx), formatter: summary('storage materialize') }
  }
  if (subcommand === 'compact') {
    const { storageCompact } = await import('../commands/storage-compact.js')
    return { result: await storageCompact({ force: !!flags.force, keepRaw: !!flags['keep-raw'] }, ctx), formatter: summary('storage compact') }
  }
  if (subcommand === 'gc') {
    const { storageGc } = await import('../commands/storage.js')
    const drop = flags.drop ? flags.drop.split(',').map((/** @type {any} */ s) => s.trim()) : []
    const olderThan = flags['older-than'] ? Number.parseInt(flags['older-than'], 10) : undefined
    return {
      result: await storageGc({ drop, olderThan, vacuum: !flags['no-vacuum'] }, ctx),
      formatter: formatStorageGc,
    }
  }
  if (subcommand === 'check-orphans') {
    const { storageCheckOrphans } = await import('../commands/storage.js')
    return { result: await storageCheckOrphans({}, ctx), formatter: summary('orphans') }
  }
  return exitHelp('storage')
}

/** @param {any} subcommand @param {any} _positional @param {any} flags @param {any} ctx */
async function dispatchSnapshot(subcommand, _positional, flags, ctx) {
  if (subcommand === 'build') {
    if (flags.tier && flags.tier !== 'full') {
      console.error(`apple-docs snapshot build: --tier ${flags.tier} is not a supported flag. Snapshots ship in a single shape; drop --tier.`)
      process.exit(2)
    }
    const { snapshotBuild } = await import('../commands/snapshot.js')
    const result = await snapshotBuild(
      {
        out: flags.out,
        tag: flags.tag,
        // F.3b: deliberate-partial-build escape hatch. Pass when
        // building on a host that can't run the SF Symbols renderer.
        allowIncompleteSymbols: !!flags['allow-incomplete-symbols'],
      },
      ctx,
    )
    return { result, formatter: summary('snapshot') }
  }
  return exitHelp('snapshot')
}

/** @param {any} _subcommand @param {any} _positional @param {any} flags @param {any} ctx */
async function dispatchConsolidate(_subcommand, _positional, flags, ctx) {
  const { consolidate } = await import('../commands/consolidate.js')
  const result = await consolidate(
    {
      dryRun: !!flags['dry-run'],
      minify: !!flags.minify,
    },
    ctx,
  )
  return { result, formatter: summary('consolidate') }
}

/** @param {any} subcommand @param {any} positional @param {any} flags @param {any} ctx */
async function dispatchIndex(subcommand, positional, flags, ctx) {
  if (subcommand === 'embeddings') {
    const { indexEmbeddings } = await import('../commands/index-embeddings.js')
    return { result: await indexEmbeddings({ full: !!flags.full }, ctx), formatter: summary('index embeddings') }
  }
  if (subcommand === 'rebuild') {
    const target = positional[0] ?? 'body'
    if (target === 'body') {
      const { rebuildBody } = await import('../commands/index-rebuild.js')
      return { result: await rebuildBody({}, ctx), formatter: summary('index rebuild body') }
    }
    if (target === 'trigram') {
      const { rebuildTrigram } = await import('../commands/index-rebuild.js')
      return { result: await rebuildTrigram({}, ctx), formatter: summary('index rebuild trigram') }
    }
    console.error(`Unknown index rebuild target: ${target} (expected "body" or "trigram")`)
    process.exit(1)
  }
  return exitHelp('index')
}

/** @param {any} flags @param {any} ctx */
async function dispatchPrune(flags, ctx) {
  const { prune } = await import('../commands/prune.js')
  const result = await prune({ dryRun: !!flags['dry-run'], noVacuum: !!flags['no-vacuum'] }, ctx)
  return { result, formatter: summary('prune') }
}

/** @param {any} ctx */
async function dispatchVersion(ctx) {
  const { VERSION } = await import('../lib/version.js')
  const { getCommitHash } = await import('../lib/git-version.js')
  /** @type {{ version: string, commit: string | null, snapshot?: any, snapshotBuildMacos?: any }} */
  const result = { version: VERSION, commit: getCommitHash() }
  // Corpus provenance is a bonus — `version` must work on a machine
  // with no corpus at all (fresh install, standalone binary).
  try {
    const tag = ctx.db.getSnapshotMeta('snapshot_tag') ?? ctx.db.getSnapshotMeta('snapshot_version')
    const buildMacos = ctx.db.getSnapshotMeta('build_macos')
    if (tag) result.snapshot = tag
    if (buildMacos) result.snapshotBuildMacos = buildMacos
  } catch {
    /* no corpus — version info stands alone */
  }
  const formatter = (/** @type {any} */ r) => {
    const lines = [`apple-docs ${r.version}${r.commit ? ` (${r.commit})` : ''}`]
    if (r.snapshot) {
      lines.push(`corpus: ${r.snapshot}${r.snapshotBuildMacos ? ` (built on macOS ${r.snapshotBuildMacos})` : ''}`)
    }
    return lines.join('\n')
  }
  return { result, formatter }
}

/** @param {any} command @param {any} subcommand @param {any} positional @param {any} flags @param {any} ctx */
export async function dispatchMaintenance(command, subcommand, positional, flags, ctx) {
  if (command === 'storage') return dispatchStorage(subcommand, positional, flags, ctx)
  if (command === 'snapshot') return dispatchSnapshot(subcommand, positional, flags, ctx)
  if (command === 'consolidate') return dispatchConsolidate(subcommand, positional, flags, ctx)
  if (command === 'index') return dispatchIndex(subcommand, positional, flags, ctx)
  if (command === 'version') return dispatchVersion(ctx)
  if (command === 'prune') return dispatchPrune(flags, ctx)
  return null
}

export const MAINTENANCE_COMMANDS = ['storage', 'snapshot', 'consolidate', 'index', 'version', 'prune']

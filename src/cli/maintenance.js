/**
 * Dispatch table for low-frequency maintenance subcommands —
 * storage, snapshot, consolidate, index. Each entry returns
 * `{ result, formatter }` so the parent cli.js stays a thin
 * pretty-printer/JSON-emitter.
 *
 * Returns null when no entry matches; cli.js then falls through
 * to its own command switch.
 */

import { formatStorageStats, formatStorageGc } from './formatter.js'
import { showHelp } from './help.js'

function exitHelp(family) {
  showHelp(family)
  process.exit(1)
}

function summary(label) {
  return (result) => `${label}: ${JSON.stringify(result)}`
}

async function dispatchStorage(subcommand, _positional, flags, ctx) {
  if (subcommand === 'stats') {
    const { storageStats } = await import('../commands/storage.js')
    return { result: await storageStats({}, ctx), formatter: formatStorageStats }
  }
  if (subcommand === 'gc') {
    const { storageGc } = await import('../commands/storage.js')
    const drop = flags.drop ? flags.drop.split(',').map(s => s.trim()) : []
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

async function dispatchSnapshot(subcommand, _positional, flags, ctx) {
  if (subcommand === 'build') {
    if (flags.tier && flags.tier !== 'full') {
      console.error(`apple-docs snapshot build: --tier ${flags.tier} is not a supported flag. Snapshots ship in a single shape; drop --tier.`)
      process.exit(2)
    }
    const { snapshotBuild } = await import('../commands/snapshot.js')
    const result = await snapshotBuild({
      out: flags.out,
      tag: flags.tag,
      // F.3b: deliberate-partial-build escape hatch. Pass when
      // building on a host that can't run the SF Symbols renderer.
      allowIncompleteSymbols: !!flags['allow-incomplete-symbols'],
    }, ctx)
    return { result, formatter: summary('snapshot') }
  }
  return exitHelp('snapshot')
}

async function dispatchConsolidate(_subcommand, _positional, flags, ctx) {
  const { consolidate } = await import('../commands/consolidate.js')
  const result = await consolidate({
    dryRun: !!flags['dry-run'],
    minify: !!flags.minify,
  }, ctx)
  return { result, formatter: summary('consolidate') }
}

async function dispatchIndex(subcommand, positional, _flags, ctx) {
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

export async function dispatchMaintenance(command, subcommand, positional, flags, ctx) {
  if (command === 'storage') return dispatchStorage(subcommand, positional, flags, ctx)
  if (command === 'snapshot') return dispatchSnapshot(subcommand, positional, flags, ctx)
  if (command === 'consolidate') return dispatchConsolidate(subcommand, positional, flags, ctx)
  if (command === 'index') return dispatchIndex(subcommand, positional, flags, ctx)
  return null
}

export const MAINTENANCE_COMMANDS = ['storage', 'snapshot', 'consolidate', 'index']

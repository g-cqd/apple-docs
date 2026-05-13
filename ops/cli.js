#!/usr/bin/env bun
/**
 * Single entry point for every ops command. Replaces the bash
 * dispatcher at ops/bin/apple-docs-ops; lazy-imports each subcommand
 * module so startup stays cheap even with many commands registered.
 *
 * Subcommands live in ops/cmd/<name>.js and each export a default
 * async function with the shape:
 *
 *   async function run({ args, env, deps }) → number (exit code)
 *
 * Tests can call dispatch() directly with a fake `loadCommand` to
 * exercise routing logic without running the real subcommand.
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const COMMANDS = Object.freeze({
  'install': { description: 'Render + install launchd plists and sudoers drop-in (root step)', loader: 'install-daemons' },
  'render-all': { description: 'Re-render every *.tpl from ops/.env', loader: 'render-all' },
  'render': { description: 'Alias for render-all', loader: 'render-all' },
  'deploy': { description: 'git pull → render → reload → corpus refresh → restart', loader: 'deploy-update' },
  'pull-snapshot': { description: 'Apply the latest GH release snapshot (no crawl)', loader: 'pull-snapshot' },
  'smoke': { description: 'Run the smoke-test probe battery', loader: 'smoke-test' },
  'cf-purge': { description: 'Purge the Cloudflare edge cache', loader: 'cf-purge' },
  'watchdog': { description: 'Long-running daemon that restarts dead services', loader: 'watchdog' },
  'watch-sync': { description: 'First-boot helper: wait for sync, then start web', loader: 'watch-sync' },
  'proxy': { description: 'Caddy proxy verbs (run|validate|reload|status)', loader: 'proxy' },
  'service': { description: 'launchd service verbs (start|stop|restart|status <target>)', loader: 'service' },
})

/**
 * Build a default deps bundle. Subcommands receive this so they can
 * substitute fakes in tests without each one having to wire up its own
 * injection points.
 *
 * @returns {{ now: () => number, exit: (n: number) => void }}
 */
export function defaultDeps() {
  return {
    now: () => Date.now(),
    exit: (code) => process.exit(code),
  }
}

/**
 * Print the usage block to a writeable stream (process.stderr by default).
 */
export function printUsage(stream = process.stderr) {
  stream.write('Usage: ops/cli.js <command> [options]\n\n')
  stream.write('Commands:\n')
  const width = Math.max(...Object.keys(COMMANDS).map(s => s.length))
  for (const [name, info] of Object.entries(COMMANDS)) {
    stream.write(`  ${name.padEnd(width + 2)}${info.description}\n`)
  }
  stream.write('\nGlobal options:\n')
  stream.write('  --help, -h    Show this message\n')
  stream.write('  --version     Print the ops layer version\n')
}

/**
 * Dispatch a parsed argv to a subcommand. Returns the subcommand's
 * exit code; never calls process.exit() itself so callers (tests,
 * embedders) can decide.
 *
 * @param {string[]} argv                  including the subcommand name as argv[0]
 * @param {{ loadCommand?: (name: string) => Promise<{ default: Function }>,
 *           env?: Record<string, string>, stderr?: { write: Function },
 *           stdout?: { write: Function } }} [deps]
 * @returns {Promise<number>}
 */
export async function dispatch(argv, deps = {}) {
  const stderr = deps.stderr ?? process.stderr
  const stdout = deps.stdout ?? process.stdout
  const loadCommand = deps.loadCommand ?? defaultLoadCommand
  const env = deps.env ?? process.env

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    printUsage(stdout)
    return 0
  }
  if (argv[0] === '--version') {
    stdout.write('apple-docs ops 2.0\n')
    return 0
  }

  const name = argv[0]
  const rest = argv.slice(1)
  const info = COMMANDS[name]
  if (!info) {
    stderr.write(`ops/cli: unknown command "${name}"\n`)
    printUsage(stderr)
    return 64 // EX_USAGE
  }

  let mod
  try {
    mod = await loadCommand(info.loader)
  } catch (err) {
    stderr.write(`ops/cli: failed to load command "${name}": ${err?.message ?? err}\n`)
    return 70 // EX_SOFTWARE
  }

  if (typeof mod?.default !== 'function') {
    stderr.write(`ops/cli: command "${name}" did not export a default function\n`)
    return 70
  }

  try {
    const result = await mod.default({ args: rest, env, deps: defaultDeps() })
    if (typeof result === 'number') return result
    return 0
  } catch (err) {
    const code = err?.exitCode ?? 1
    stderr.write(`ops/cli: command "${name}" failed: ${err?.message ?? err}\n`)
    return code
  }
}

function defaultLoadCommand(loader) {
  const here = dirname(fileURLToPath(import.meta.url))
  return import(join(here, 'cmd', `${loader}.js`))
}

if (import.meta.main) {
  dispatch(process.argv.slice(2)).then((code) => process.exit(code))
}

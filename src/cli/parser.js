/**
 * Commands that accept a second-level subcommand (e.g. `mcp start`, `web serve`).
 * For these, the next non-flag argument after the command is consumed as `subcommand`.
 */
const COMMAND_FAMILIES = new Set(['mcp', 'web', 'storage', 'snapshot', 'index'])

/**
 * Flags that never consume the next positional argument as their value.
 * Without this, `--skip-git-auth some-positional` would set
 * `flags['skip-git-auth'] = 'some-positional'` and drop the positional.
 */
const BOOLEAN_FLAGS = new Set([
  'help',
  'verbose',
  'json',
  'full',
  'force',
  'downgrade',
  'verify',
  'minify',
  'dry-run',
  'index',
  'read',
  'retry-failed',
  'no-vacuum',
  'no-deep',
  'no-eager',
  'no-fuzzy',
  'use-git-auth',
  'skip-git-auth',
])

/**
 * Minimal argv parser. Returns { command, subcommand, positional, flags }.
 * Handles: --key value, --bool, positional args, -- separator, 2-level commands.
 */
export function parseArgs(argv) {
  const args = argv.slice(2) // skip runtime and script path
  const command = args[0] && !args[0].startsWith('-') ? args[0] : null

  // Check for subcommand on command families
  let subcommand = null
  if (command && COMMAND_FAMILIES.has(command)) {
    const next = args[1]
    if (next && !next.startsWith('-')) {
      subcommand = next
    }
  }

  const positional = []
  const flags = {}
  const start = command ? (subcommand ? 2 : 1) : 0

  for (let i = start; i < args.length; i++) {
    if (args[i] === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true
        continue
      }
      // Check if next arg is a value (not a flag)
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(args[i])
    }
  }

  return { command, subcommand, positional, flags }
}

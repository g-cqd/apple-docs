/**
 * Commands that accept a second-level subcommand (e.g. `mcp start`, `web serve`).
 * For these, the next non-flag argument after the command is consumed as `subcommand`.
 */
const COMMAND_FAMILIES = new Set(['mcp', 'web', 'storage', 'snapshot'])

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

/**
 * Minimal argv parser. Returns { command, positional, flags }.
 * Handles: --key value, --bool, positional args, -- separator.
 */
export function parseArgs(argv) {
  const args = argv.slice(2) // skip runtime and script path
  const command = args[0] && !args[0].startsWith('-') ? args[0] : null
  const positional = []
  const flags = {}
  const start = command ? 1 : 0

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

  return { command, positional, flags }
}

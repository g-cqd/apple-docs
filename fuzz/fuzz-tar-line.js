/**
 * parseTarVerboseLine reads `tar -tv` output for an archive we just
 * downloaded, and the archive validator keys its containment checks off the
 * `type` and `path` it returns. Malformed or hostile listing text must not
 * crash the parse, and must not let an entry present itself as a benign
 * file type.
 */

import { parseTarVerboseLine } from '../src/commands/setup/validate-archive.js'

export function fuzz(data) {
  const text = data.toString('utf8')
  // Real callers feed one line at a time; a NUL or newline inside the buffer
  // is exactly the kind of smuggling we want to explore, so split the way
  // the caller does rather than sanitising first.
  for (const line of text.split('\n')) {
    const entry = parseTarVerboseLine(line)
    if (entry == null) continue

    if (typeof entry.type !== 'string' || entry.type.length !== 1) {
      throw new Error(`entry.type is not a single char: ${JSON.stringify(entry.type)}`)
    }
    if (typeof entry.path !== 'string') {
      throw new Error(`entry.path is not a string: ${JSON.stringify(entry.path)}`)
    }
    // A `d` line describing a directory must never come back as a regular
    // file: the validator applies its strictest path rules to non-'-' types,
    // so a type downgrade would skip them.
    if (line.startsWith('d') && entry.type !== 'd') {
      throw new Error(`directory line parsed as type ${JSON.stringify(entry.type)}: ${JSON.stringify(line)}`)
    }
    if (line.startsWith('l') && entry.type !== 'l') {
      throw new Error(`symlink line parsed as type ${JSON.stringify(entry.type)}: ${JSON.stringify(line)}`)
    }
    // The link target is either absent or a string — the validator
    // dereferences it when present.
    if (entry.link != null && typeof entry.link !== 'string') {
      throw new Error(`entry.link is neither null nor a string: ${JSON.stringify(entry.link)}`)
    }
  }
}

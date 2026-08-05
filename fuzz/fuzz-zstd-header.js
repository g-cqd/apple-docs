/**
 * zstdContentSize parses the frame header of a freshly downloaded archive to
 * decide how much disk the extraction needs. It does raw offset arithmetic
 * over attacker-supplied bytes (RFC 8878 Frame_Content_Size), and its result
 * feeds `needed = size * 2.05` in the setup preflight.
 *
 * Two properties matter. It must never throw — a crash here aborts an
 * install before extraction. And it must never hand back a value that makes
 * the preflight nonsense: negative, NaN, or non-integer.
 */

import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdContentSize } from '../src/commands/setup/disk-space.js'

// One staging dir for the whole campaign — mkdtemp per iteration would make
// the filesystem, not the parser, the bottleneck.
const dir = mkdtempSync(join(tmpdir(), 'apple-docs-fuzz-zstd-'))
const path = join(dir, 'frame.tar.zst')

process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

export function fuzz(data) {
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, data, 0, data.length, 0)
  } finally {
    closeSync(fd)
  }

  const size = zstdContentSize(path)
  if (size === null) return

  if (typeof size !== 'number') {
    throw new Error(`non-numeric frame size: ${JSON.stringify(size)}`)
  }
  if (!Number.isFinite(size)) {
    throw new Error(`non-finite frame size: ${size}`)
  }
  if (size < 0) {
    throw new Error(`negative frame size: ${size}`)
  }
  if (!Number.isInteger(size)) {
    throw new Error(`fractional frame size: ${size}`)
  }
}

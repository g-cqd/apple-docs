/**
 * Build-time IO helpers — brotli precompression for static assets and
 * recursive directory copy for the public/ tree.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { ensureDir } from '../../storage/files.js'

/**
 * Files smaller than this are NOT precompressed at build time — Caddy's
 * runtime encode directive compresses them quickly enough at request time
 * and the brotli-quality-11 cost would dominate the build.
 */
export const PRECOMPRESS_THRESHOLD = 16 * 1024

export async function maybePrecompress(filePath, body) {
  const len = typeof body === 'string' ? Buffer.byteLength(body) : body.length
  if (len < PRECOMPRESS_THRESHOLD) return
  const buf = typeof body === 'string' ? Buffer.from(body) : body
  const br = brotliCompressSync(buf, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: len,
    },
  })
  await Bun.write(`${filePath}.br`, br)
}

/**
 * Recursively copy `src` into `dst`, overwriting existing files. Used to
 * stage the static `public/` tree (robots.txt, llms.txt, security.txt) into
 * the build output. Doesn't follow symlinks.
 */
export async function copyDirRecursive(src, dst) {
  ensureDir(dst)
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyDirRecursive(from, to)
    } else if (entry.isFile()) {
      // Bun.write accepts a path source via Bun.file(...) and is faster than
      // readFileSync + writeFileSync because it streams; size check just so
      // we don't accidentally inflate the build with a stray multi-GB blob.
      const size = statSync(from).size
      if (size > 16 * 1024 * 1024) {
        throw new Error(`refusing to copy ${from} (${size} bytes) into static public dir`)
      }
      await Bun.write(to, Bun.file(from))
    }
  }
}

/** Minify CSS by stripping comments, collapsing whitespace, and removing unnecessary characters. */

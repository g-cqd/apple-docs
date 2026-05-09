// Atomic publish step for full builds: the orchestrator writes into a
// staging dir alongside `outDir`, then renames staging over the live
// directory in a single filesystem op so no partial output is ever
// served. On failure, restores the previous output.
//
// Pulled out of web/build.js as part of Phase B.

import { existsSync } from 'node:fs'

/**
 * @param {object} args
 * @param {string} args.outDir   — public output path that consumers (Caddy) read
 * @param {string} args.buildDir — staging dir we just finished writing
 * @param {string} args.previousDir — temp name for the soon-to-be-replaced live dir
 * @param {{ rename: typeof import('node:fs/promises').rename, rm: typeof import('node:fs/promises').rm }} args.fsOps
 * @param {object} [args.logger]
 */
export async function atomicPublish({ outDir, buildDir, previousDir, fsOps, logger }) {
  let hadPreviousOutput = false
  if (existsSync(outDir)) {
    await fsOps.rename(outDir, previousDir)
    hadPreviousOutput = true
  }
  try {
    await fsOps.rename(buildDir, outDir)
  } catch (error) {
    if (hadPreviousOutput && existsSync(previousDir) && !existsSync(outDir)) {
      await fsOps.rename(previousDir, outDir)
    }
    logger?.error?.(`Static site publish failed: ${error.message}`)
    throw error
  }
  if (hadPreviousOutput) {
    await fsOps.rm(previousDir, { recursive: true, force: true })
  }
}

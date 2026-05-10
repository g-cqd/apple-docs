// Build-time asset pipeline: copy + minify the per-server static assets
// into the build output.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ENTRY_BUNDLES, STANDALONE_ASSETS, WORKER_ASSETS } from '../assets-manifest.js'
import { minifyJs } from '../asset-bundler.js'
import { copyDirRecursive } from './io.js'
import { minifyCSS } from './minify-css.js'

/**
 * Run the asset pipeline against `buildDir`.
 *   - Minify and write CSS.
 *   - Bundle every entry in ENTRY_BUNDLES via Bun.build.
 *   - Minify each STANDALONE_ASSETS file.
 *   - Copy every WORKER_ASSETS file verbatim (workers run as ES modules,
 *     no IIFE wrap).
 *   - Recursively copy public/ (robots.txt, llms.txt, etc) — orchestrator
 *     only; workers in `--frameworks <chunk>` mode skip this so they
 *     don't race to overwrite partition-specific homepages.
 *
 * @param {{ srcWebDir: string, buildDir: string, isOrchestratorRun: boolean }} args
 */
export async function runAssetPipeline({ srcWebDir, buildDir, isOrchestratorRun }) {
  const rawCSS = readFileSync(join(srcWebDir, 'assets', 'style.css'), 'utf8')
  await Bun.write(join(buildDir, 'assets', 'style.css'), minifyCSS(rawCSS))

  // Bundle JS into logical groups to reduce HTTP requests. Each entry in
  // ENTRY_BUNDLES points at `src/web/assets/entries/*.entry.js` which imports
  // the bundle members in the right side-effect order. Bun.build resolves the
  // entry, inlines members, and emits one minified IIFE-wrapped output.
  for (const [bundleName, entryRel] of Object.entries(ENTRY_BUNDLES)) {
    const entryPath = join(srcWebDir, 'assets', entryRel)
    await Bun.write(join(buildDir, 'assets', bundleName), await minifyJs(entryPath))
  }
  for (const file of STANDALONE_ASSETS) {
    const src = join(srcWebDir, 'assets', file)
    if (existsSync(src)) {
      await Bun.write(join(buildDir, 'assets', file), await minifyJs(src))
    }
  }
  for (const file of WORKER_ASSETS) {
    const src = join(srcWebDir, 'worker', file)
    if (existsSync(src)) {
      await Bun.write(join(buildDir, 'worker', file), readFileSync(src, 'utf8'))
    }
  }

  // Copy the static public/ tree (robots.txt, llms.txt, security.txt, etc).
  // Orchestrator only — workers running with `--frameworks <chunk>` would
  // re-do the copy needlessly, and the bigger problem is that index.html
  // and the search page below are *partition-specific* when frameworkFilter
  // is set. Letting six workers race to overwrite them ends with the
  // last-finished worker's partition replacing the full corpus index.
  const publicSrc = join(srcWebDir, 'public')
  if (isOrchestratorRun && existsSync(publicSrc)) {
    await copyDirRecursive(publicSrc, buildDir)
  }
}

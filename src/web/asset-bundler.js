import { join } from 'node:path'

/**
 * Minify a single browser-targeted JS source file via `Bun.build`.
 *
 * The asset sources are IIFE-wrapped standalone scripts with no imports
 * between them, so Bun.build acts as a minifier here, not a bundler in
 * the multi-file sense. Concatenation into bundle outputs (`core.js`,
 * `listing.js`) happens at the call site.
 *
 * @param {string} entrypoint Absolute path to a single .js file.
 * @returns {Promise<string>} Minified source text.
 */
export async function minifyJs(entrypoint) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'browser',
    minify: true,
  })
  if (!result.success) {
    const message = result.logs?.map(l => l.message ?? String(l)).join('\n') ?? 'build failed'
    throw new Error(`Bun.build failed for ${entrypoint}: ${message}`)
  }
  const output = result.outputs?.[0]
  if (!output) throw new Error(`Bun.build produced no output for ${entrypoint}`)
  return await output.text()
}

/**
 * Minify and concatenate a named bundle (e.g. `core.js`) from its source
 * member list.
 *
 * @param {{ srcWebDir: string, members: string[] }} args
 * @returns {Promise<string>}
 */
export async function buildJsBundle({ srcWebDir, members }) {
  const minified = await Promise.all(
    members.map(member => minifyJs(join(srcWebDir, 'assets', member))),
  )
  return minified.join('\n')
}

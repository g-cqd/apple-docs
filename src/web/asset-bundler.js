/**
 * Build a single browser-targeted JS entrypoint via `Bun.build` and return
 * the minified source text.
 *
 * `format: 'iife'` wraps the bundle in a self-executing IIFE so the
 * output works as a plain `<script src=...>` (no `type="module"`
 * required) and the module's top-level statements run on load. Without
 * this, Bun emits ESM with `export` statements that browsers refuse to
 * execute outside a module script tag.
 *
 * Used by both `src/web/build.js` (static rendering) and
 * `src/web/routes/assets.route.js` (live dev preview), which keeps the
 * minified bytes identical between the two paths.
 *
 * @param {string} entrypoint Absolute path to a .js file.
 * @returns {Promise<string>} Minified source text.
 */
export async function minifyJs(entrypoint) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'browser',
    minify: true,
    format: 'iife',
  })
  if (!result.success) {
    const message = result.logs?.map(l => l.message ?? String(l)).join('\n') ?? 'build failed'
    throw new Error(`Bun.build failed for ${entrypoint}: ${message}`)
  }
  const output = result.outputs?.[0]
  if (!output) throw new Error(`Bun.build produced no output for ${entrypoint}`)
  return await output.text()
}

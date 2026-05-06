import { listAppleFonts, syncAppleFonts } from '../resources/apple-assets.js'

/**
 * Manage Apple typography resources (the `apple-docs fonts ...` family).
 * @param {object} opts
 * @param {object} ctx
 */
export async function fonts(opts, ctx) {
  switch (opts.action) {
    case 'sync':
      return {
        action: 'sync',
        ...(await syncAppleFonts({ downloadFonts: opts.download === true }, ctx)),
      }
    case 'list':
      return { action: 'list', ...listAppleFonts(ctx) }
    default:
      throw new Error(`Unknown fonts action: ${opts.action}`)
  }
}

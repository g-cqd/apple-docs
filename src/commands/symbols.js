import { prerenderSfSymbols, searchSfSymbols, syncSfSymbols } from '../resources/apple-assets.js'

/**
 * Manage SF Symbols resources (the `apple-docs symbols ...` family).
 * @param {object} opts
 * @param {object} ctx
 */
export async function symbols(opts, ctx) {
  switch (opts.action) {
    case 'sync': {
      const includePrivate = opts.excludePrivate ? false : opts.includePrivate !== false
      const scopes = includePrivate ? ['public', 'private'] : ['public']
      const counts = { public: 0, private: 0 }
      for (const scope of scopes) {
        counts[scope] = await syncSfSymbols({ scope }, ctx)
      }
      // Skip prerender on plain `symbols sync` unless explicitly requested.
      // It takes minutes; users can run `symbols render` separately or pass
      // --render to chain.
      let render = null
      if (opts.render === true) {
        render = await prerenderSfSymbols({
          concurrency: opts.concurrency,
          resetCache: opts.resetCache,
          onProgress: opts.onProgress,
        }, ctx)
      }
      return { action: 'sync', counts, ...(render ? { render } : {}) }
    }
    case 'render':
      return {
        action: 'render',
        ...await prerenderSfSymbols({
          scope: opts.scope,
          concurrency: opts.concurrency,
          resetCache: opts.resetCache,
          onProgress: opts.onProgress,
        }, ctx),
      }
    case 'search':
      return {
        action: 'search',
        ...searchSfSymbols(opts.query ?? '', {
          scope: opts.scope,
          limit: opts.limit,
        }, ctx),
      }
    default:
      throw new Error(`Unknown symbols action: ${opts.action}`)
  }
}

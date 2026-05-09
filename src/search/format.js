/**
 * Result-row formatter. Maps the wide search row produced by the storage
 * layer to the public CLI/MCP shape that the formatter / projection
 * layers expect.
 *
 * Pulled out of commands/search.js as part of P2.6.
 */

export function formatResult(r) {
  return {
    title: r.title,
    framework: r.framework,
    rootSlug: r.root_slug,
    sourceType: r.source_type ?? null,
    sourceMetadata: r.source_metadata ?? null,
    kind: r.role_heading ?? r.role,
    abstract: r.abstract,
    path: r.path,
    platforms: r.platforms ? (typeof r.platforms === 'string' ? JSON.parse(r.platforms) : r.platforms) : [],
    declaration: r.declaration,
    urlDepth: r.url_depth ?? 0,
    isReleaseNotes: !!(r.is_release_notes),
    language: r.language ?? null,
    ...(r.is_deprecated ? { isDeprecated: true } : {}),
    ...(r.is_beta ? { isBeta: true } : {}),
  }
}

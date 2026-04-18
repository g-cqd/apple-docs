/**
 * MCP payload projection.
 *
 * The command layer (search, lookup, browse, frameworks, status) emits fat
 * payloads that carry everything web and CLI consumers need. MCP callers are
 * LLMs paying by the token — they see the projected shape instead. This module
 * strips MCP-only noise, collapses the `found: false` scaffolding, and turns
 * full-doc reads into a lightweight section skeleton unless the caller asked
 * for a specific slice.
 *
 * Resources share these projections with the corresponding tools so that
 * `apple-docs://doc/…` and `read_doc` never diverge.
 */

/** Fields stripped from every search hit and from the embedded bestMatch. */
const SEARCH_HIT_MCP_FIELDS = ['urlDepth', 'isReleaseNotes', 'score', 'sourceMetadata']

/** Top-level fields stripped from search_docs responses. */
const SEARCH_RESULT_MCP_FIELDS = ['intent', 'trigramAvailable', 'bodyIndexAvailable']

/** Fields stripped from section entries. */
const SECTION_STRIP_FIELDS = ['sectionKind', 'sortOrder']

export function projectSearchResult(result) {
  if (!result || typeof result !== 'object') return result
  const projected = { ...result }
  for (const f of SEARCH_RESULT_MCP_FIELDS) delete projected[f]
  if (Array.isArray(projected.results)) {
    projected.results = projected.results.map(projectSearchHit)
  }
  return projected
}

export function projectSearchHit(hit) {
  if (!hit || typeof hit !== 'object') return hit
  const out = { ...hit }
  for (const f of SEARCH_HIT_MCP_FIELDS) delete out[f]
  return out
}

/**
 * Project a lookup/read_doc payload.
 *
 * - found:false collapses to { found: false, note? }
 * - sections: full shape when full=true (section=/match= was passed or pagination set), otherwise a skeleton of [{ heading, chars }]
 * - section fields `sectionKind` / `sortOrder` are always dropped
 */
export function projectReadDoc(payload, opts = {}) {
  if (!payload || typeof payload !== 'object') return payload
  if (payload.found === false) {
    return payload.note ? { found: false, note: payload.note } : { found: false }
  }

  const full = !!opts.full
  const out = { ...payload }

  if (Array.isArray(out.sections)) {
    out.sections = full
      ? out.sections.map(projectSection)
      : out.sections.map(sectionSkeleton)
  }

  if (out.bestMatch) out.bestMatch = projectSearchHit(out.bestMatch)
  return out
}

function projectSection(section) {
  if (!section || typeof section !== 'object') return section
  const out = { ...section }
  for (const f of SECTION_STRIP_FIELDS) delete out[f]
  return out
}

function sectionSkeleton(section) {
  const heading = section?.heading ?? null
  const text = typeof section?.contentText === 'string' ? section.contentText : ''
  return { heading, chars: text.length }
}

export function projectFrameworks(result) {
  if (!result || typeof result !== 'object') return result
  const out = { ...result }
  if (Array.isArray(out.roots)) {
    out.roots = out.roots.map(projectRoot)
  }
  return out
}

function projectRoot(root) {
  if (!root || typeof root !== 'object') return root
  const out = { ...root }
  delete out.lastSeen
  return out
}

export function projectBrowse(result) {
  if (!result || typeof result !== 'object') return result
  const out = { ...result }
  delete out.slug
  return out
}

export function projectStatus(result) {
  if (!result || typeof result !== 'object') return result
  const out = { ...result }
  delete out.dataDir
  return out
}

export function projectTaxonomy(result) {
  return result
}

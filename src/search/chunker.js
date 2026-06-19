/**
 * Deterministic, dependency-free document chunker for the body-aware semantic
 * index. The embedder used to see only `title + abstract + headings` (the
 * "anchor"); the prose — which lives fully in `document_sections` — was thrown
 * away, capping recall. This splits a document into a small set of embeddable
 * chunks so the body is actually represented in vector space.
 *
 *   - Chunk 0 is the anchor, byte-identical to the old whole-doc embedding
 *     input. That guarantees ≥1 chunk per doc, no regression on the signal we
 *     already had, and an anchor code that old (whole-doc) readers can still use.
 *   - Then heading-aware body chunks from the kept sections (discussion /
 *     overview / named topics …). Declaration, parameter, and REST-schema
 *     sections are skipped — they're symbol noise, not prose.
 *   - Long sections are split by a char-based sliding window (a deterministic
 *     ~4-chars-per-token proxy; no tokenizer dependency) so the determinism
 *     gate stays byte-stable.
 *
 * Pure: same input → same chunk list, always.
 */

// Anchor input length cap — matches the historical embedText() slice so chunk
// 0's embedding is identical to the pre-chunking whole-doc embedding.
const ANCHOR_MAX = 1200

// Section kinds that carry declaration / parameter / REST-schema noise rather
// than prose. Everything else (discussion, overview, topics, content, …) is
// kept, which naturally captures DocC's open-ended "named topic" headings.
const SKIP_SECTION_KINDS = new Set(['declaration', 'parameters', 'parameter', 'returnvalue', 'return value', 'attributes', 'availability'])

/** Build the anchor string — identical to the legacy embedText() input. @param {any} doc */
export function anchorText(doc) {
  return [doc.title, doc.abstract_text, doc.headings].filter(Boolean).join('. ').slice(0, ANCHOR_MAX)
}

/**
 * Split `text` into overlapping windows. A single window is returned when the
 * text already fits; otherwise windows of `size` chars step forward by
 * `size - overlap` so adjacent chunks share context.
 */
/** @param {string} text @param {number} size @param {number} overlap */
function slidingWindow(text, size, overlap) {
  if (text.length <= size) return [text]
  const step = Math.max(1, size - overlap)
  const out = []
  for (let i = 0; i < text.length; i += step) {
    out.push(text.slice(i, i + size))
    if (i + size >= text.length) break
  }
  return out
}

/**
 * @param {{ title?: string, abstract_text?: string, headings?: string, sections?: Array<{ sectionKind?: string, section_kind?: string, heading?: string, contentText?: string, content_text?: string }> }} doc
 * @param {{ maxChunks?: number, windowChars?: number, overlapChars?: number }} [opts]
 * @returns {string[]} chunk texts, chunk 0 = anchor (always present)
 */
export function chunkDocument(doc, { maxChunks = 8, windowChars = 880, overlapChars = 160 } = {}) {
  const chunks = [anchorText(doc)]
  const sections = doc?.sections ?? []
  const hasAbstract = !!doc?.abstract_text

  for (const s of sections) {
    if (chunks.length >= maxChunks) break
    const kind = String(s.sectionKind ?? s.section_kind ?? '').toLowerCase()
    if (SKIP_SECTION_KINDS.has(kind) || kind.startsWith('rest')) continue
    // The abstract is already in the anchor — don't spend a chunk slot on it.
    if (kind === 'abstract' && hasAbstract) continue
    const body = String(s.contentText ?? s.content_text ?? '').trim()
    if (!body) continue
    const heading = s.heading ? `${s.heading}. ` : ''
    for (const piece of slidingWindow(heading + body, windowChars, overlapChars)) {
      if (chunks.length >= maxChunks) break
      chunks.push(piece)
    }
  }
  return chunks
}

const HOWTO_WORDS = /\b(how|guide|tutorial|example|implement|create|build|use|setup|configure|add|make)\b/i
const ERROR_WORDS = /\b(error|crash|exception|fail|issue|bug|fix|troubleshoot|exc_bad|abort|segfault)\b/i
const CONCEPT_PATTERNS = /\b(what\s+is|difference\s+between|vs\.?|overview|introduction|explain)\b/i
const WWDC_PATTERN = /\bwwdc\b|\b20[12]\d\b/i
const CAMEL_CASE = /[a-z][A-Z]/
const QUALIFIED_NAME = /[.:]{2}|(?:[A-Z]\w+\.(?:[a-z]\w+|[A-Z]\w+))/
const SINGLE_CAPITALIZED = /^[A-Z][A-Za-z0-9]+$/

/**
 * Detect the intent behind a search query.
 * @param {string} query
 * @returns {{ type: 'symbol'|'howto'|'error'|'concept'|'general', confidence: number }}
 */
export function detectIntent(query) {
  if (!query || !query.trim()) return { type: 'general', confidence: 0.5 }

  const q = query.trim()

  // Symbol: CamelCase or qualified names (highest priority)
  if (CAMEL_CASE.test(q) || QUALIFIED_NAME.test(q)) {
    return { type: 'symbol', confidence: 0.9 }
  }

  // Symbol: single capitalized word (e.g. "View", "Publisher")
  if (SINGLE_CAPITALIZED.test(q)) {
    return { type: 'symbol', confidence: 0.7 }
  }

  // Error-related queries
  if (ERROR_WORDS.test(q)) {
    return { type: 'error', confidence: 0.8 }
  }

  // How-to queries
  if (HOWTO_WORDS.test(q)) {
    return { type: 'howto', confidence: 0.8 }
  }

  // Conceptual queries
  if (CONCEPT_PATTERNS.test(q)) {
    return { type: 'concept', confidence: 0.7 }
  }

  // WWDC / conference queries (year or "wwdc" keyword)
  if (WWDC_PATTERN.test(q)) {
    return { type: 'wwdc', confidence: 0.8 }
  }

  return { type: 'general', confidence: 0.5 }
}

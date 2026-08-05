/**
 * extractFrontmatter runs over every Markdown body in the corpus, including
 * the ones an enrichment or crawl pulled off the network. It does index
 * arithmetic on delimiters (`---`, `\n---`) and hands the remainder to a
 * YAML parse.
 *
 * Properties: it never throws on arbitrary text, it always returns the
 * documented shape, and the body it returns is a suffix of the input — a
 * body longer than the input would mean the slicing invented content.
 */

import { extractFrontmatter } from '../src/content/parse-markdown.js'

export function fuzz(data) {
  const text = data.toString('utf8')
  const result = extractFrontmatter(text)

  // No explicit null/shape guard: extractFrontmatter returns an object
  // literal on every path, so CodeQL correctly flags `result == null` as
  // statically dead (js/comparison-between-incompatible-types). It also buys
  // nothing — were it ever to return null, the property reads below throw a
  // TypeError, which the fuzzer reports as a crash just the same.
  if (typeof result.body !== 'string') {
    throw new Error(`body is not a string: ${JSON.stringify(result.body)}`)
  }
  if (result.body.length > text.length) {
    throw new Error(`body (${result.body.length}) longer than input (${text.length})`)
  }
  // No frontmatter means the body is the input verbatim — the parser must
  // not silently drop leading content when it declines to parse.
  if (result.frontmatter === null && result.body !== text) {
    throw new Error('declined frontmatter but still altered the body')
  }
  if (result.frontmatter !== null && typeof result.frontmatter !== 'object') {
    throw new Error(`frontmatter is neither null nor an object: ${JSON.stringify(result.frontmatter)}`)
  }
}

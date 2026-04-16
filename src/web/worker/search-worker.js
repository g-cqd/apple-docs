let titleIndex = null // v2 columnar or v1 row-based (normalized on load)
let aliases = null
let baseUrl = ''

// Inverted index: Map<term, Set<entryIndex>>
let invertedIndex = null
// Prefix index: Map<prefix, Set<entryIndex>> for prefixes of length >= 2
let prefixIndex = null

self.addEventListener('message', async (event) => {
  const { type, query, limit, base, seqId } = event.data

  if (type === 'init') {
    if (base) baseUrl = base
    try {
      // Try loading the manifest first for content-hashed filenames
      let titleUrl = `${baseUrl}/data/search/title-index.json`
      let aliasUrl = `${baseUrl}/data/search/aliases.json`

      try {
        const manifestResp = await fetch(`${baseUrl}/data/search/search-manifest.json`)
        if (manifestResp.ok) {
          const manifest = await manifestResp.json()
          if (manifest.files) {
            if (manifest.files['title-index']) {
              titleUrl = `${baseUrl}/data/search/${manifest.files['title-index']}`
            }
            if (manifest.files.aliases) {
              aliasUrl = `${baseUrl}/data/search/${manifest.files.aliases}`
            }
          }
        }
      } catch {
        // Manifest not available — fall back to unhashed filenames
      }

      const [titleResp, aliasResp] = await Promise.all([
        fetch(titleUrl),
        fetch(aliasUrl),
      ])
      titleIndex = await titleResp.json()
      aliases = await aliasResp.json()
      normalizeIndex()
      buildIndices()
      self.postMessage({ type: 'ready' })
    } catch (e) {
      self.postMessage({ type: 'error', message: e.message })
    }
    return
  }

  if (type === 'search') {
    if (!titleIndex || !invertedIndex) {
      self.postMessage({ type: 'results', results: [], query, seqId })
      return
    }
    const results = searchEntries(query, limit || 10)
    self.postMessage({ type: 'results', results, query, seqId })
  }
})

/**
 * Normalize the title index into a consistent columnar format.
 * Supports both v1 (row-based) and v2 (columnar) formats.
 *
 * After normalization, `titleIndex` always has:
 * - `frameworks`: string[]
 * - `keys`: string[]
 * - `titles`: string[]
 * - `abstracts`: string[]
 * - `fwIndices`: number[]
 * - `kinds`: string[]
 * - `roleHeadings`: string[]
 * - `count`: number
 */
function normalizeIndex() {
  if (titleIndex.v === 2) {
    // v2 columnar format — already in the right shape
    titleIndex.count = titleIndex.keys.length
    return
  }

  // v1 row-based format: { frameworks, entries: [[key, title, abstract, fwIdx, kind, roleHeading], ...] }
  const entries = titleIndex.entries || []
  titleIndex.keys = entries.map((e) => e[0])
  titleIndex.titles = entries.map((e) => e[1])
  titleIndex.abstracts = entries.map((e) => e[2])
  titleIndex.fwIndices = entries.map((e) => e[3])
  titleIndex.kinds = entries.map((e) => e[4])
  titleIndex.roleHeadings = entries.map((e) => e[5])
  titleIndex.count = entries.length
}

/**
 * Tokenize a string by splitting on camelCase boundaries, spaces, dots,
 * underscores, slashes, and lowercasing.
 */
function tokenize(text) {
  // Insert a space before uppercase letters that follow a lowercase letter (camelCase)
  const expanded = text.replace(/([a-z])([A-Z])/g, '$1 $2')
  return expanded
    .toLowerCase()
    .split(/[\s._/\\]+/)
    .filter((t) => t.length > 0)
}

/**
 * Build the inverted index and prefix index from the columnar title data.
 */
function buildIndices() {
  invertedIndex = new Map()
  prefixIndex = new Map()

  const count = titleIndex.count

  for (let i = 0; i < count; i++) {
    const title = titleIndex.titles[i]
    const key = titleIndex.keys[i]

    // Collect all terms from title and key
    const titleTerms = tokenize(title)
    const keyTerms = tokenize(key)
    const allTerms = new Set([...titleTerms, ...keyTerms])

    for (const term of allTerms) {
      // Add to inverted index
      if (!invertedIndex.has(term)) {
        invertedIndex.set(term, new Set())
      }
      invertedIndex.get(term).add(i)

      // Add all prefixes of length >= 2 to prefix index
      const maxLen = term.length
      for (let len = 2; len <= maxLen; len++) {
        const prefix = term.substring(0, len)
        if (!prefixIndex.has(prefix)) {
          prefixIndex.set(prefix, new Set())
        }
        prefixIndex.get(prefix).add(i)
      }
    }
  }
}

/**
 * Look up candidate entry indices for a single query term.
 * Checks exact match in inverted index first, then falls back to prefix index.
 */
function lookupTerm(term) {
  // Exact match in inverted index
  const exact = invertedIndex.get(term)
  if (exact && exact.size > 0) return exact

  // Prefix match
  const prefixed = prefixIndex.get(term)
  if (prefixed && prefixed.size > 0) return prefixed

  return null
}

/**
 * Intersect an array of Sets, returning a new Set.
 */
function intersectSets(sets) {
  if (sets.length === 0) return new Set()
  if (sets.length === 1) return new Set(sets[0])

  // Start with the smallest set for efficiency
  const sorted = sets.slice().sort((a, b) => a.size - b.size)
  const result = new Set(sorted[0])
  for (let i = 1; i < sorted.length; i++) {
    const other = sorted[i]
    for (const val of result) {
      if (!other.has(val)) {
        result.delete(val)
      }
    }
    if (result.size === 0) break
  }
  return result
}

/**
 * Union an array of Sets, returning a new Set.
 */
function unionSets(sets) {
  const result = new Set()
  for (const s of sets) {
    for (const val of s) {
      result.add(val)
    }
  }
  return result
}

function searchEntries(query, limit) {
  const terms = tokenize(query)
  if (terms.length === 0) return []

  const queryLower = query.toLowerCase()

  // Look up candidates for each term
  const termSets = []
  for (const term of terms) {
    const candidates = lookupTerm(term)
    if (candidates) {
      termSets.push(candidates)
    }
  }

  // Determine candidate set:
  // - If all terms have matches, intersect for multi-term precision
  // - If some terms have no matches, union what we have (partial match)
  // - If no terms match, try alias expansion as a last resort
  let candidateIndices
  if (termSets.length === terms.length) {
    // All terms found — intersect
    candidateIndices = intersectSets(termSets)
  } else if (termSets.length > 0) {
    // Some terms found — union for partial matches
    candidateIndices = unionSets(termSets)
  } else {
    candidateIndices = new Set()
  }

  // If no candidates from index, check aliases against all entries
  // (aliases are rare so this is a small fallback)
  if (candidateIndices.size === 0 && aliases) {
    for (const term of terms) {
      const canonical = aliases[term]
      if (canonical) {
        // Look up the canonical name in the index
        const aliasResults = lookupTerm(canonical)
        if (aliasResults) {
          for (const idx of aliasResults) {
            candidateIndices.add(idx)
          }
        }
      }
    }
  }

  const scored = []

  for (const i of candidateIndices) {
    const key = titleIndex.keys[i]
    const title = titleIndex.titles[i]
    const abstract = titleIndex.abstracts[i]
    const fwIdx = titleIndex.fwIndices[i]
    const kind = titleIndex.kinds[i]
    const roleHeading = titleIndex.roleHeadings[i]
    const framework = fwIdx >= 0 ? titleIndex.frameworks[fwIdx] : ''

    const titleLower = title.toLowerCase()
    const keyLower = key.toLowerCase()

    let score = 0

    // Exact title match
    if (titleLower === queryLower) {
      score = 100
    }
    // Title starts with query
    else if (titleLower.startsWith(queryLower)) {
      score = 80
    }
    // Key ends with query (path match)
    else if (keyLower.endsWith(`/${queryLower}`) || keyLower === queryLower) {
      score = 75
    }
    // All terms found in title
    else if (terms.every((t) => titleLower.includes(t))) {
      score = 60
    }
    // Some terms found in title or key
    else {
      const matched = terms.filter((t) => titleLower.includes(t) || keyLower.includes(t))
      if (matched.length > 0) {
        score = 30 * (matched.length / terms.length)
      }
    }

    // Alias expansion: boost if query matches a framework synonym
    if (aliases && score === 0) {
      for (const term of terms) {
        const canonical = aliases[term]
        if (canonical && (framework === canonical || framework === term)) {
          score = Math.max(score, 20)
        }
      }
    }

    if (score > 0) {
      // Depth penalty
      const depth = (key.match(/\//g) || []).length
      score -= depth * 0.5

      scored.push({ key, title, abstract, framework, kind, roleHeading, score })
    }
  }

  // Sort by score descending, then by title length ascending (prefer shorter titles)
  scored.sort((a, b) => b.score - a.score || a.title.length - b.title.length)
  return scored.slice(0, limit)
}

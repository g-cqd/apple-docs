let titleIndex = null // v2 columnar or v1 row-based (normalized on load)
let aliases = null
let baseUrl = ''

// Postings stored as sorted Uint32Array — lookup returns Uint32Array,
// intersect/union are merge-walks on sorted runs, and each entry costs
// 4 B versus ~32–50 B per element in a Set<number>. Prefix length is
// capped at 4; longer prefixes are redundant with the inverted-index
// entry for the full term and dominate the index size.
const PREFIX_MAX_LEN = 4

/** @type {Map<string, Uint32Array> | null} */
let invertedIndex = null
/** @type {Map<string, Uint32Array> | null} */
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
 *
 * Build phase uses arrays (which we later convert) so we can append cheaply
 * without paying Set overhead on every insert. The final conversion sorts
 * each posting and deduplicates in one pass.
 */
function buildIndices() {
  const invertedBuilders = new Map()
  const prefixBuilders = new Map()

  const count = titleIndex.count

  for (let i = 0; i < count; i++) {
    const title = titleIndex.titles[i]
    const key = titleIndex.keys[i]

    // Collect all terms from title and key (dedup at term level only —
    // posting-level dedup happens at the conversion step).
    const titleTerms = tokenize(title)
    const keyTerms = tokenize(key)
    const seenTerm = new Set()
    for (const term of titleTerms) seenTerm.add(term)
    for (const term of keyTerms) seenTerm.add(term)

    for (const term of seenTerm) {
      // Inverted index
      let invList = invertedBuilders.get(term)
      if (!invList) {
        invList = []
        invertedBuilders.set(term, invList)
      }
      invList.push(i)

      // Prefix index — cap at PREFIX_MAX_LEN.
      const maxLen = Math.min(term.length, PREFIX_MAX_LEN)
      for (let len = 2; len <= maxLen; len++) {
        const prefix = term.substring(0, len)
        let preList = prefixBuilders.get(prefix)
        if (!preList) {
          preList = []
          prefixBuilders.set(prefix, preList)
        }
        preList.push(i)
      }
    }
  }

  invertedIndex = freezePostings(invertedBuilders)
  prefixIndex = freezePostings(prefixBuilders)
}

/**
 * Convert each Array of doc indices into a sorted, deduplicated
 * Uint32Array. After this the build-phase Map+Array structure is
 * eligible for GC; only the typed arrays survive.
 */
function freezePostings(builders) {
  const out = new Map()
  for (const [term, list] of builders) {
    list.sort((a, b) => a - b)
    // Dedup in place. Each `seenTerm` Set at build prevents duplicates
    // within a single doc; the remaining duplicates would be from
    // tokens appearing in both `title` and `key`. Inline dedup keeps
    // the posting strictly increasing for the merge-walks below.
    let writeIdx = 0
    let prev = -1
    for (let i = 0; i < list.length; i++) {
      if (list[i] !== prev) {
        list[writeIdx++] = list[i]
        prev = list[i]
      }
    }
    out.set(term, Uint32Array.from(list.slice(0, writeIdx)))
  }
  return out
}

/**
 * Look up candidate entry indices for a single query term.
 * Checks exact match in inverted index first, then falls back to prefix index.
 *
 * @returns {Uint32Array | null}
 */
function lookupTerm(term) {
  const exact = invertedIndex.get(term)
  if (exact && exact.length > 0) return exact

  if (term.length <= PREFIX_MAX_LEN) {
    const prefixed = prefixIndex.get(term)
    if (prefixed && prefixed.length > 0) return prefixed
  } else {
    // Longer query terms: a prefix lookup on the first PREFIX_MAX_LEN
    // chars gives a superset; the scoring loop below filters to actual
    // substring matches.
    const prefixed = prefixIndex.get(term.substring(0, PREFIX_MAX_LEN))
    if (prefixed && prefixed.length > 0) return prefixed
  }

  return null
}

/**
 * Intersect a list of sorted Uint32Arrays using a merge-walk.
 * Returns a new Uint32Array. O(sum of lengths) — much cheaper than
 * the previous Set-based approach for large posting lists.
 */
function intersectPostings(lists) {
  if (lists.length === 0) return new Uint32Array(0)
  if (lists.length === 1) return lists[0]

  // Start from the smallest list so the candidate set is bounded by it.
  const sorted = lists.slice().sort((a, b) => a.length - b.length)
  let acc = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    acc = intersectTwoSorted(acc, sorted[i])
    if (acc.length === 0) return acc
  }
  return acc
}

function intersectTwoSorted(a, b) {
  const out = new Uint32Array(Math.min(a.length, b.length))
  let ai = 0
  let bi = 0
  let oi = 0
  while (ai < a.length && bi < b.length) {
    const av = a[ai]
    const bv = b[bi]
    if (av === bv) { out[oi++] = av; ai++; bi++ }
    else if (av < bv) ai++
    else bi++
  }
  return out.subarray(0, oi)
}

/**
 * Union a list of sorted Uint32Arrays. Uses a k-way merge via a min
 * walk — simple and fast for the small list count we hit (one per
 * query term).
 */
function unionPostings(lists) {
  if (lists.length === 0) return new Uint32Array(0)
  if (lists.length === 1) return lists[0]
  let acc = lists[0]
  for (let i = 1; i < lists.length; i++) acc = unionTwoSorted(acc, lists[i])
  return acc
}

function unionTwoSorted(a, b) {
  const out = new Uint32Array(a.length + b.length)
  let ai = 0
  let bi = 0
  let oi = 0
  while (ai < a.length && bi < b.length) {
    const av = a[ai]
    const bv = b[bi]
    if (av === bv) { out[oi++] = av; ai++; bi++ }
    else if (av < bv) { out[oi++] = av; ai++ }
    else { out[oi++] = bv; bi++ }
  }
  while (ai < a.length) out[oi++] = a[ai++]
  while (bi < b.length) out[oi++] = b[bi++]
  return out.subarray(0, oi)
}

function searchEntries(query, limit) {
  const terms = tokenize(query)
  if (terms.length === 0) return []

  const queryLower = query.toLowerCase()

  // Look up candidates for each term
  const termPostings = []
  for (const term of terms) {
    const candidates = lookupTerm(term)
    if (candidates) {
      termPostings.push(candidates)
    }
  }

  // Determine candidate set:
  // - If all terms have matches, intersect for multi-term precision
  // - If some terms have no matches, union what we have (partial match)
  // - If no terms match, try alias expansion as a last resort
  let candidateIndices
  if (termPostings.length === terms.length) {
    candidateIndices = intersectPostings(termPostings)
  } else if (termPostings.length > 0) {
    candidateIndices = unionPostings(termPostings)
  } else {
    candidateIndices = new Uint32Array(0)
  }

  // If no candidates from index, check aliases against all entries
  // (aliases are rare so this is a small fallback). Accumulate into a
  // Set since the alias paths may overlap with each other; convert
  // once to keep the scoring loop uniform.
  if (candidateIndices.length === 0 && aliases) {
    const aliasSet = new Set()
    for (const term of terms) {
      const canonical = aliases[term]
      if (canonical) {
        const aliasResults = lookupTerm(canonical)
        if (aliasResults) {
          for (let i = 0; i < aliasResults.length; i++) aliasSet.add(aliasResults[i])
        }
      }
    }
    if (aliasSet.size > 0) candidateIndices = Uint32Array.from(aliasSet).sort()
  }

  const scored = []

  for (let n = 0; n < candidateIndices.length; n++) {
    const i = candidateIndices[n]
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

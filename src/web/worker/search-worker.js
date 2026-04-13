let titleIndex = null // { frameworks, entries }
let aliases = null
const _bodyShards = {}
let baseUrl = ''

self.addEventListener('message', async (event) => {
  const { type, query, limit, base } = event.data

  if (type === 'init') {
    if (base) baseUrl = base
    try {
      const [titleResp, aliasResp] = await Promise.all([
        fetch(`${baseUrl}/data/search/title-index.json`),
        fetch(`${baseUrl}/data/search/aliases.json`),
      ])
      titleIndex = await titleResp.json()
      aliases = await aliasResp.json()
      self.postMessage({ type: 'ready' })
    } catch (e) {
      self.postMessage({ type: 'error', message: e.message })
    }
    return
  }

  if (type === 'search') {
    if (!titleIndex) {
      self.postMessage({ type: 'results', results: [], query })
      return
    }
    const results = searchEntries(query, limit || 10)
    self.postMessage({ type: 'results', results, query })
  }
})

function tokenize(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

function searchEntries(query, limit) {
  const terms = tokenize(query)
  if (terms.length === 0) return []

  const queryLower = query.toLowerCase()
  const scored = []

  for (const entry of titleIndex.entries) {
    // entry: [key, title, abstract, frameworkIndex, kind, roleHeading]
    const key = entry[0]
    const title = entry[1]
    const abstract = entry[2]
    const fwIdx = entry[3]
    const kind = entry[4]
    const roleHeading = entry[5]
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

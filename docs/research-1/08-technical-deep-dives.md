# Technical Deep Dives

## Detailed technical investigations for key implementation areas

---

## 1. Apple's Documentation JSON API Surface

### 1.1 Known Endpoints

| Endpoint | Pattern | Returns |
|----------|---------|---------|
| Technologies index | `https://developer.apple.com/tutorials/data/documentation/technologies.json` | Full framework catalog |
| Documentation page | `https://developer.apple.com/tutorials/data/documentation/{path}.json` | DocC JSON for any page |
| HIG page | `https://developer.apple.com/tutorials/data/design/{path}.json` | HIG content in DocC format |
| Tutorials | `https://developer.apple.com/tutorials/data/tutorials/{path}.json` | Tutorial content |
| Search | `https://developer.apple.com/search/api?q={query}&type=Documentation` | Search results |
| WWDC sessions | `https://developer.apple.com/tutorials/data/videos/play/wwdc{year}/{id}.json` | Session metadata |

### 1.2 DocC JSON Structure

```json
{
  "metadata": {
    "title": "View",
    "role": "symbol",
    "roleHeading": "Protocol",
    "modules": [{"name": "SwiftUI"}],
    "platforms": [
      {"name": "iOS", "introducedAt": "13.0"},
      {"name": "macOS", "introducedAt": "10.15"}
    ],
    "symbolKind": "protocol",
    "fragments": [{"kind": "keyword", "text": "protocol"}, {"kind": "identifier", "text": "View"}]
  },
  "abstract": [
    {"type": "text", "text": "A type that represents part of your app's user interface."}
  ],
  "primaryContentSections": [
    {"kind": "declarations", "declarations": [...]},
    {"kind": "content", "content": [...]},
    {"kind": "parameters", "parameters": [...]}
  ],
  "topicSections": [
    {"title": "Creating a View", "identifiers": ["doc://com.apple.SwiftUI/documentation/SwiftUI/View/body-swift.property"]}
  ],
  "relationshipsSections": [
    {"type": "conformsTo", "title": "Conforms To", "identifiers": [...]}
  ],
  "seeAlsoSections": [...],
  "references": {
    "doc://com.apple.SwiftUI/documentation/SwiftUI/View/body-swift.property": {
      "title": "body", "type": "topic", "role": "symbol", "url": "/documentation/swiftui/view/body-swift.property"
    }
  }
}
```

### 1.3 Content Node Types

The renderer must handle all of these:

**Block-level nodes:**
- `paragraph` -- inline content
- `heading` -- with `level` (1-6) and `text` or `inlineContent`
- `codeListing` -- with `syntax` and `code` (array of lines)
- `unorderedList` / `orderedList` -- with `items` (each has `content`)
- `aside` -- with `style` (Note, Important, Warning, Experiment, Tip, Deprecated) and `content`
- `table` -- with `rows` (each has `cells`, each has `content`)
- `links` -- with `items` (reference identifiers)
- `termList` -- definition list with `term` and `definition`
- `row` / `tabNavigator` / `dictionaryExample` -- rare, usually in tutorials
- `endpointExample` -- REST API example

**Inline nodes:**
- `text` -- plain text
- `codeVoice` -- inline code (`code` property)
- `emphasis` -- italic
- `strong` -- bold
- `newTerm` -- bold (semantic)
- `reference` -- link to another doc page
- `link` -- external URL
- `image` -- image reference
- `superscript` / `subscript` / `strikethrough`
- `inlineHead` -- bold (in table headers)

### 1.4 Platform Availability Extraction

From `metadata.platforms`:
```javascript
function extractPlatforms(metadata) {
  const platforms = {}
  for (const p of metadata.platforms ?? []) {
    const key = p.name.toLowerCase().replace(/\s+/g, '')
    // "iOS" -> "ios", "macOS" -> "macos", "visionOS" -> "visionos"
    platforms[`min_${key}`] = p.introducedAt || null
  }
  return platforms
}
```

### 1.5 Language Detection

From declaration tokens:
```javascript
function detectLanguage(declarations) {
  for (const decl of declarations) {
    for (const lang of decl.languages ?? []) {
      if (lang === 'swift') return 'swift'
      if (lang === 'occ') return 'objc'
    }
  }
  return null
}
```

---

## 2. Swift Evolution Proposal Parsing

### 2.1 Proposal Header Format

Each proposal starts with a structured header:

```markdown
# Feature Name

* Proposal: [SE-0401](0401-remove-actor-isolation-inference.md)
* Authors: [Holly Borla](https://github.com/hborla)
* Review Manager: [John McCall](https://github.com/rjmccall)
* Status: **Implemented (Swift 6.0)**
* Implementation: apple/swift#12345
```

### 2.2 Parser

```javascript
function parseProposalHeader(content) {
  const lines = content.split('\n')
  const result = {}

  // Title (first H1)
  const titleLine = lines.find(l => l.startsWith('# '))
  result.title = titleLine?.slice(2).trim() ?? 'Untitled'

  // Extract metadata from bullet list
  for (const line of lines.slice(0, 30)) {
    const match = line.match(/^\*\s+(.+?):\s*(.+)$/)
    if (!match) continue
    const [, key, value] = match

    switch (key.toLowerCase().trim()) {
      case 'proposal':
        result.seNumber = value.match(/SE-(\d+)/)?.[1] ?? ''
        break
      case 'status':
        result.status = value.replace(/\*\*/g, '').trim()
        break
      case 'implementation':
        result.implementation = value.trim()
        break
    }
  }

  // Extract Swift version from status
  const versionMatch = result.status?.match(/Swift\s+(\d+\.\d+)/i)
  result.swiftVersion = versionMatch?.[1] ?? null

  // Authors from bullet list
  const authorsLine = lines.find(l => /^\*\s+Authors?:/i.test(l))
  result.authors = authorsLine
    ? [...authorsLine.matchAll(/\[(.+?)\]/g)].map(m => m[1])
    : []

  return result
}
```

---

## 3. HTML-to-Markdown Conversion for Web Sources

For sources like swift.org and Apple Archive that serve HTML, we need an HTML-to-Markdown converter.

### 3.1 Using Bun's HTMLRewriter

```javascript
// src/lib/html-to-markdown.js
export function htmlToMarkdown(html) {
  const parts = []
  let listDepth = 0
  let inCodeBlock = false
  let codeBlockLang = ''

  const rewriter = new HTMLRewriter()
    .on('h1', { text(t) { parts.push(`# ${t.text}`) } })
    .on('h2', { text(t) { parts.push(`\n## ${t.text}`) } })
    .on('h3', { text(t) { parts.push(`\n### ${t.text}`) } })
    .on('h4', { text(t) { parts.push(`\n#### ${t.text}`) } })
    .on('p', { text(t) { if (!inCodeBlock) parts.push(`\n${t.text}`) } })
    .on('code', {
      element(el) {
        if (el.tagName === 'pre') return // handled by pre
        parts.push('`')
      },
      text(t) { parts.push(t.text) },
    })
    .on('pre', {
      element(el) {
        inCodeBlock = true
        codeBlockLang = el.getAttribute('data-language') || ''
        parts.push(`\n\`\`\`${codeBlockLang}\n`)
      },
      text(t) { parts.push(t.text) },
    })
    .on('strong, b', { text(t) { parts.push(`**${t.text}**`) } })
    .on('em, i', { text(t) { parts.push(`*${t.text}*`) } })
    .on('a', {
      element(el) { parts.push(`[`) },
      text(t) { parts.push(t.text) },
    })
    .on('ul > li', { text(t) { parts.push(`\n- ${t.text}`) } })
    .on('ol > li', { text(t) { parts.push(`\n1. ${t.text}`) } })

  // Note: HTMLRewriter is streaming, designed for Response bodies.
  // For string HTML, wrap in a Response:
  const response = new Response(html)
  const transformed = rewriter.transform(response)

  // We collect parts via side effects (not ideal but works)
  // Alternative: use a simpler regex-based approach for offline HTML

  return parts.join('').trim()
}
```

### 3.2 Alternative: Simple Regex-Based Converter

For offline HTML processing where streaming isn't needed:

```javascript
export function simpleHtmlToMarkdown(html) {
  return html
    // Remove script, style, nav, header, footer
    .replace(/<(script|style|nav|header|footer)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Headings
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n')
    // Code blocks
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '```\n$1\n```\n')
    // Inline code
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    // Bold / italic
    .replace(/<(strong|b)[^>]*>(.*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>(.*?)<\/\1>/gi, '*$2*')
    // Links
    .replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    // Images
    .replace(/<img[^>]+src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)')
    // List items
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    // Paragraphs
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
    // Line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
```

---

## 4. WWDC Transcript Sources

### 4.1 Apple's Official Transcripts (2020+)

Apple hosts transcripts at:
```
https://developer.apple.com/videos/play/wwdc{year}/{sessionId}/
```

The JSON API endpoint:
```
https://developer.apple.com/tutorials/data/videos/play/wwdc{year}/{sessionId}.json
```

This returns structured data similar to DocC pages.

### 4.2 ASCIIwwdc (2012-2020)

GitHub repository: `ASCIIwwdc/asciiwwdc.com`
Content location: `https://raw.githubusercontent.com/ASCIIwwdc/asciiwwdc.com/master/content/{year}/{sessionId}.md`

### 4.3 Session Discovery

Apple lists all sessions per year:
```
https://developer.apple.com/tutorials/data/videos/wwdc{year}.json
```

Returns an array of session objects with:
- `id` -- session number
- `title` -- session title
- `description` -- abstract
- `topics` -- array of topic tags
- `url` -- path to session page

---

## 5. Swift Package Index Integration

### 5.1 Package List

The master list: `https://raw.githubusercontent.com/SwiftPackageIndex/PackageList/main/packages.json`

Returns: array of 10,674+ GitHub URLs (as of April 2026):
```json
[
  "https://github.com/Alamofire/Alamofire.git",
  "https://github.com/vapor/vapor.git",
  ...
]
```

### 5.2 GitHub API for Metadata

```javascript
async function fetchPackageMetadata(ownerRepo) {
  const repo = await fetch(
    `https://api.github.com/repos/${ownerRepo}`,
    { headers: { 'Authorization': `Bearer ${githubToken}` } }
  ).then(r => r.json())

  return {
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    stars: repo.stargazers_count,
    license: repo.license?.spdx_id,
    topics: repo.topics,
    language: repo.language,
    updatedAt: repo.updated_at,
    archived: repo.archived,
    url: repo.html_url,
  }
}
```

### 5.3 Rate Limiting

GitHub API rate limits:
- **Without token:** 60 requests/hour (useless for 10K+ packages)
- **With token:** 5,000 requests/hour
- **With fine-grained PAT:** 5,000 requests/hour

For 10,674 packages at 5,000/hour: ~2.1 hours minimum. Use batch processing with checkpointing.

### 5.4 README Fetching

```javascript
async function fetchReadme(ownerRepo) {
  const response = await fetch(
    `https://api.github.com/repos/${ownerRepo}/readme`,
    {
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.raw+json',
      }
    }
  )
  if (!response.ok) return null
  return await response.text()
}
```

---

## 6. Client-Side Search Optimization

### 6.1 Compressed Search Index

For static site deployment, minimize the search index:

```javascript
// Build time: generate compressed index
function buildCompressedIndex(db) {
  const pages = db.query(`
    SELECT p.path, p.title, p.abstract, r.slug as fw
    FROM pages p JOIN roots r ON p.root_id = r.id
    WHERE p.status = 'active' AND p.title IS NOT NULL
  `).all()

  // Deduplicate frameworks into a lookup table
  const frameworks = [...new Set(pages.map(p => p.fw))].sort()
  const fwIndex = Object.fromEntries(frameworks.map((fw, i) => [fw, i]))

  // Compact format: [path, title, abstract_50chars, fw_index]
  const entries = pages.map(p => [
    p.path,
    p.title,
    (p.abstract || '').slice(0, 80),
    fwIndex[p.fw],
  ])

  return {
    f: frameworks,  // framework lookup
    d: entries,     // documents
  }
}
```

**Size estimate:**
- 330K entries * ~80 bytes average = ~26 MB uncompressed
- gzip: ~4-6 MB
- brotli: ~3-4 MB

### 6.2 Incremental Loading

```javascript
// Client-side: load index in chunks
async function loadSearchIndex() {
  // Phase 1: Load titles only (fast, small)
  const resp = await fetch('/search-index.json')
  const { f: frameworks, d: docs } = await resp.json()

  return { frameworks, docs }
}
```

### 6.3 Web Worker Search

For large indexes, move search to a Web Worker to avoid blocking the UI:

```javascript
// search-worker.js
let index = null

self.onmessage = async (e) => {
  if (e.data.type === 'load') {
    const resp = await fetch(e.data.url)
    index = await resp.json()
    self.postMessage({ type: 'ready' })
  } else if (e.data.type === 'search') {
    const results = performSearch(index, e.data.query)
    self.postMessage({ type: 'results', results })
  }
}
```

---

## 7. Pre-built Database Distribution

### 7.1 Database Size Estimates

| Content | Estimated Size |
|---------|---------------|
| Core schema + metadata (330K pages) | ~150 MB |
| FTS5 index (title, abstract, path, declaration) | ~80 MB |
| Trigram index | ~50 MB |
| Body FTS5 index | ~200 MB |
| Refs table | ~30 MB |
| **Total (with body index)** | **~510 MB** |
| **Total (without body index)** | **~310 MB** |

### 7.2 Compression

```bash
# gzip: ~120 MB compressed (from 310 MB)
tar -czf apple-docs-db.tar.gz apple-docs.db

# zstd: ~90 MB compressed (better ratio, faster decompression)
tar -cf - apple-docs.db | zstd -19 -o apple-docs-db.tar.zst
```

### 7.3 Distribution Tiers

| Tier | Contents | Size (compressed) | Use Case |
|------|----------|-------------------|----------|
| **Lite** | Metadata + FTS5 (no body, no trigram) | ~80 MB | Quick start, basic search |
| **Standard** | Metadata + FTS5 + trigram + body | ~120 MB | Full search capability |
| **Full** | Standard + raw JSON files | ~400 MB | Full offline + re-rendering |

### 7.4 Auto-Update Strategy

```javascript
// Check for database updates weekly
async function checkForUpdate(currentVersion) {
  const release = await fetch(
    'https://api.github.com/repos/g-cqd/apple-docs-data/releases/latest'
  ).then(r => r.json())

  if (release.tag_name !== currentVersion) {
    return { available: true, version: release.tag_name, url: release.assets[0]?.browser_download_url }
  }
  return { available: false }
}
```

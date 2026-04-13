# Static Website Design: Searchable Apple Documentation

## Serving apple-docs as a deployable static website with dynamic search

---

## 1. Overview

The goal is to add a `serve` command to apple-docs that:
1. **Development mode:** Starts a local HTTP server rendering documentation pages on-the-fly
2. **Build mode:** Generates a complete static website that can be deployed to any CDN
3. **Search:** Provides client-side full-text search backed by our existing search strategies

---

## 2. Architecture

### 2.1 Two Modes

```
apple-docs serve                    # Dev server on localhost:3000
apple-docs serve --port 8080        # Custom port
apple-docs serve --build            # Build static site to dist/
apple-docs serve --build --out ./site  # Custom output directory
```

### 2.2 Dev Server (Dynamic)

Uses `Bun.serve()` for a fast local development server:

```javascript
// src/web/server.js
import { renderPage } from './renderer.js'
import { renderSearch } from './search-page.js'
import { renderIndex } from './index-page.js'
import { renderFrameworkList } from './frameworks-page.js'

export function startWebServer(ctx, options = {}) {
  const { port = 3000 } = options

  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)

      // Static assets
      if (url.pathname.startsWith('/assets/')) {
        return serveAsset(url.pathname)
      }

      // Search API (JSON endpoint for client-side JS)
      if (url.pathname === '/api/search') {
        const query = url.searchParams.get('q')
        const source = url.searchParams.get('source')
        const framework = url.searchParams.get('framework')
        const results = await search({ query, source, framework, limit: 50 }, ctx)
        return Response.json(results)
      }

      // Search page (HTML)
      if (url.pathname === '/search') {
        return new Response(renderSearch(), { headers: { 'content-type': 'text/html' } })
      }

      // Framework listing
      if (url.pathname === '/frameworks') {
        return new Response(renderFrameworkList(ctx), { headers: { 'content-type': 'text/html' } })
      }

      // Index page
      if (url.pathname === '/') {
        return new Response(renderIndex(ctx), { headers: { 'content-type': 'text/html' } })
      }

      // Documentation page: /docs/{path}
      if (url.pathname.startsWith('/docs/')) {
        const docPath = url.pathname.slice(6) // Remove '/docs/'
        return new Response(renderDocPage(docPath, ctx), {
          headers: { 'content-type': 'text/html' }
        })
      }

      return new Response('Not Found', { status: 404 })
    },
  })
}
```

### 2.3 Static Build

Pre-renders all pages to HTML files:

```javascript
// src/web/build.js
export async function buildStaticSite(ctx, outputDir) {
  const { db, dataDir } = ctx

  mkdirSync(outputDir, { recursive: true })

  // 1. Copy static assets (CSS, JS, fonts)
  await copyAssets(outputDir)

  // 2. Render index page
  writeFileSync(join(outputDir, 'index.html'), renderIndex(ctx))

  // 3. Render search page (with embedded search index)
  const searchIndex = buildClientSearchIndex(ctx)
  writeFileSync(join(outputDir, 'search.html'), renderSearch())
  writeFileSync(join(outputDir, 'search-index.json'), JSON.stringify(searchIndex))

  // 4. Render framework listing
  writeFileSync(join(outputDir, 'frameworks.html'), renderFrameworkList(ctx))

  // 5. Render all documentation pages
  const pages = db.db.query("SELECT path, title FROM pages WHERE status = 'active'").all()
  let rendered = 0

  for (const page of pages) {
    const htmlPath = join(outputDir, 'docs', page.path + '.html')
    mkdirSync(dirname(htmlPath), { recursive: true })
    writeFileSync(htmlPath, renderDocPage(page.path, ctx))

    rendered++
    if (rendered % 10000 === 0) {
      ctx.logger.info(`Rendered ${rendered}/${pages.length} pages`)
    }
  }

  ctx.logger.info(`Static site built: ${rendered} pages in ${outputDir}`)
}
```

---

## 3. Page Rendering

### 3.1 HTML Template

Each page wraps markdown content in a consistent HTML shell:

```javascript
// src/web/renderer.js
export function renderDocPage(docPath, ctx) {
  const { db, dataDir } = ctx

  // Load markdown content
  const mdPath = join(dataDir, 'markdown', docPath + '.md')
  let markdown
  if (existsSync(mdPath)) {
    markdown = readFileSync(mdPath, 'utf-8')
  } else {
    // On-the-fly rendering from JSON (see 06-markdown-generation.md)
    const jsonPath = join(dataDir, 'raw-json', docPath + '.json')
    if (existsSync(jsonPath)) {
      const json = JSON.parse(readFileSync(jsonPath, 'utf-8'))
      markdown = renderPage(json, docPath) // existing renderer
    } else {
      return render404(docPath)
    }
  }

  // Parse front matter
  const { frontMatter, body } = parseFrontMatter(markdown)

  // Convert markdown to HTML
  // Using Bun.markdown if available, otherwise a simple converter
  const htmlContent = markdownToHtml(body)

  // Get page metadata
  const page = db.getPage(docPath)
  const refs = page ? db.getRefsBySource(page.id) : []

  return htmlTemplate({
    title: frontMatter.title || page?.title || docPath,
    framework: frontMatter.framework || page?.framework,
    role: frontMatter.role,
    platforms: frontMatter.platforms || [],
    path: docPath,
    content: htmlContent,
    breadcrumbs: buildBreadcrumbs(docPath),
    childTopics: refs.filter(r => r.section === 'Topics'),
    seeAlso: refs.filter(r => r.section === 'See Also'),
  })
}
```

### 3.2 HTML Shell

```javascript
function htmlTemplate({ title, framework, content, breadcrumbs, path }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Apple Docs</title>
  <link rel="stylesheet" href="/assets/style.css">
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
</head>
<body>
  <header>
    <nav class="top-nav">
      <a href="/" class="logo">Apple Docs</a>
      <div class="search-bar">
        <input type="search" id="search-input" placeholder="Search documentation..."
               aria-label="Search documentation">
        <div id="search-results" class="search-dropdown" hidden></div>
      </div>
      <a href="/frameworks">Frameworks</a>
    </nav>
  </header>

  <main>
    <nav class="breadcrumbs" aria-label="Breadcrumbs">
      ${breadcrumbs.map(b => `<a href="/docs/${b.path}">${escapeHtml(b.title)}</a>`).join(' / ')}
    </nav>

    ${framework ? `<div class="framework-badge">${escapeHtml(framework)}</div>` : ''}

    <article class="doc-content">
      ${content}
    </article>
  </main>

  <footer>
    <p>Generated by <a href="https://github.com/g-cqd/apple-docs">apple-docs</a></p>
  </footer>

  <script src="/assets/search.js" defer></script>
</body>
</html>`
}
```

---

## 4. Client-Side Search

### 4.1 Search Index Generation

For static builds, we export a compressed search index:

```javascript
// src/web/search-index.js
export function buildClientSearchIndex(ctx) {
  // Export a lightweight index: title + path + abstract + framework
  // Full FTS5 is server-side only; client uses a simpler approach
  const pages = ctx.db.db.query(`
    SELECT p.path, p.title, p.abstract, p.role, r.slug as framework
    FROM pages p
    JOIN roots r ON p.root_id = r.id
    WHERE p.status = 'active' AND p.title IS NOT NULL
    ORDER BY p.title
  `).all()

  // Build a compact index: array of [path, title, abstract_snippet, framework]
  return pages.map(p => ([
    p.path,
    p.title,
    (p.abstract || '').slice(0, 120),
    p.framework,
    p.role,
  ]))
}
```

### 4.2 Client-Side Search JavaScript

```javascript
// src/web/assets/search.js
let searchIndex = null
let searchTimeout = null

async function loadSearchIndex() {
  if (searchIndex) return searchIndex
  const resp = await fetch('/search-index.json')
  searchIndex = await resp.json()
  return searchIndex
}

function searchDocs(query) {
  if (!searchIndex || !query) return []

  const terms = query.toLowerCase().split(/\s+/)
  const results = []

  for (const [path, title, abstract, framework, role] of searchIndex) {
    const titleLower = title.toLowerCase()
    const abstractLower = abstract.toLowerCase()
    let score = 0

    for (const term of terms) {
      // Exact title match
      if (titleLower === term) score += 100
      // Title starts with term
      else if (titleLower.startsWith(term)) score += 50
      // Title contains term
      else if (titleLower.includes(term)) score += 20
      // Abstract contains term
      else if (abstractLower.includes(term)) score += 5
      // Framework matches
      if (framework?.toLowerCase().includes(term)) score += 10
    }

    if (score > 0) {
      results.push({ path, title, abstract, framework, role, score })
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
}

// Wire up search input
const input = document.getElementById('search-input')
const resultsDiv = document.getElementById('search-results')

input?.addEventListener('input', (e) => {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(async () => {
    await loadSearchIndex()
    const results = searchDocs(e.target.value)
    renderSearchResults(results)
  }, 150) // Debounce 150ms
})

function renderSearchResults(results) {
  if (!results.length) {
    resultsDiv.hidden = true
    return
  }
  resultsDiv.hidden = false
  resultsDiv.innerHTML = results.map(r => `
    <a href="/docs/${r.path}" class="search-result">
      <span class="result-title">${escapeHtml(r.title)}</span>
      ${r.framework ? `<span class="result-framework">${escapeHtml(r.framework)}</span>` : ''}
      <span class="result-abstract">${escapeHtml(r.abstract)}</span>
    </a>
  `).join('')
}
```

### 4.3 Enhanced Search for Dev Server

In dev server mode, search hits the SQLite database directly (not the client-side index):

```javascript
// /api/search endpoint uses our full tiered search
if (url.pathname === '/api/search') {
  const query = url.searchParams.get('q')
  if (!query) return Response.json([])

  const results = await search({
    query,
    source: url.searchParams.get('source'),
    framework: url.searchParams.get('framework'),
    limit: 50,
  }, ctx)

  return Response.json(results.results)
}
```

The search.js client detects which mode it's in:
```javascript
// If we have /api/search, use it (dev mode); otherwise use local index (static mode)
async function performSearch(query) {
  try {
    const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
    if (resp.ok) return await resp.json()
  } catch {}
  // Fallback to client-side search
  await loadSearchIndex()
  return searchDocs(query)
}
```

---

## 5. CSS Design

### 5.1 Design Principles

- Clean, readable typography (system font stack)
- Light/dark mode (respects `prefers-color-scheme`)
- Responsive (mobile-friendly)
- Code syntax highlighting
- Minimal -- not trying to replicate Apple's design, but clean and functional

### 5.2 Core Styles

```css
/* src/web/assets/style.css */
:root {
  --bg: #ffffff;
  --text: #1d1d1f;
  --text-secondary: #6e6e73;
  --accent: #0066cc;
  --code-bg: #f5f5f7;
  --border: #d2d2d7;
  --nav-bg: #fbfbfd;
  --max-width: 980px;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --mono: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1d1d1f;
    --text: #f5f5f7;
    --text-secondary: #a1a1a6;
    --accent: #2997ff;
    --code-bg: #2d2d2f;
    --border: #424245;
    --nav-bg: #161617;
  }
}

* { margin: 0; padding: 0; box-sizing: border-box; }
html { font-size: 16px; }
body { font-family: var(--font); color: var(--text); background: var(--bg); line-height: 1.6; }

.top-nav {
  display: flex; align-items: center; gap: 1.5rem;
  max-width: var(--max-width); margin: 0 auto; padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border); background: var(--nav-bg);
  position: sticky; top: 0; z-index: 100;
}

.logo { font-weight: 700; color: var(--text); text-decoration: none; font-size: 1.1rem; }

.search-bar { flex: 1; position: relative; max-width: 400px; }
.search-bar input {
  width: 100%; padding: 0.5rem 1rem; border: 1px solid var(--border);
  border-radius: 8px; background: var(--bg); color: var(--text);
  font-size: 0.9rem;
}

main { max-width: var(--max-width); margin: 0 auto; padding: 2rem 1rem; }

.breadcrumbs { color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 1rem; }
.breadcrumbs a { color: var(--accent); text-decoration: none; }

.framework-badge {
  display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px;
  background: var(--code-bg); font-size: 0.8rem; color: var(--text-secondary);
  margin-bottom: 1rem;
}

.doc-content h1 { font-size: 2rem; margin-bottom: 0.5rem; }
.doc-content h2 { font-size: 1.5rem; margin-top: 2rem; margin-bottom: 0.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }
.doc-content h3 { font-size: 1.2rem; margin-top: 1.5rem; margin-bottom: 0.5rem; }
.doc-content p { margin-bottom: 1rem; }
.doc-content code { font-family: var(--mono); font-size: 0.9em; background: var(--code-bg); padding: 0.1rem 0.3rem; border-radius: 3px; }
.doc-content pre { background: var(--code-bg); padding: 1rem; border-radius: 8px; overflow-x: auto; margin-bottom: 1rem; }
.doc-content pre code { background: none; padding: 0; }
.doc-content a { color: var(--accent); text-decoration: none; }
.doc-content a:hover { text-decoration: underline; }
.doc-content table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
.doc-content th, .doc-content td { padding: 0.5rem; border: 1px solid var(--border); text-align: left; }
.doc-content th { background: var(--code-bg); font-weight: 600; }
.doc-content blockquote { border-left: 3px solid var(--accent); padding-left: 1rem; margin: 1rem 0; color: var(--text-secondary); }
.doc-content ul, .doc-content ol { padding-left: 1.5rem; margin-bottom: 1rem; }
.doc-content li { margin-bottom: 0.25rem; }

.search-dropdown {
  position: absolute; top: 100%; left: 0; right: 0;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  max-height: 400px; overflow-y: auto; margin-top: 4px;
}

.search-result {
  display: block; padding: 0.75rem 1rem; text-decoration: none;
  border-bottom: 1px solid var(--border); color: var(--text);
}
.search-result:hover { background: var(--code-bg); }
.result-title { font-weight: 600; display: block; }
.result-framework { font-size: 0.8rem; color: var(--text-secondary); }
.result-abstract { font-size: 0.85rem; color: var(--text-secondary); display: block; margin-top: 0.25rem; }

footer { max-width: var(--max-width); margin: 0 auto; padding: 2rem 1rem; color: var(--text-secondary); font-size: 0.85rem; border-top: 1px solid var(--border); }
```

---

## 6. Deployment Options

### 6.1 GitHub Pages

```yaml
# .github/workflows/deploy-site.yml
name: Deploy Documentation Site
on:
  workflow_dispatch:
  schedule:
    - cron: '0 6 * * 1'  # Weekly Monday 6am UTC

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun run cli.js setup  # Download pre-built DB
      - run: bun run cli.js serve --build --out ./site
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./site
```

### 6.2 Cloudflare Pages

```bash
# Build command
bun run cli.js setup && bun run cli.js serve --build --out ./dist

# Output directory: dist/
```

### 6.3 Vercel

```json
// vercel.json
{
  "buildCommand": "bun run cli.js setup && bun run cli.js serve --build --out ./dist",
  "outputDirectory": "dist"
}
```

### 6.4 Docker (Self-hosted)

```dockerfile
FROM oven/bun:latest
WORKDIR /app
COPY . .
RUN bun run cli.js setup
EXPOSE 3000
CMD ["bun", "run", "cli.js", "serve", "--port", "3000"]
```

---

## 7. Search Index Size Considerations

### 7.1 Full Index

With ~330,000 pages, the search index JSON would be approximately:
- Title + path + abstract (120 chars) per page
- ~100 bytes per entry average
- Total: ~33 MB uncompressed, ~5-8 MB gzipped

### 7.2 Tiered Index Strategy

For static builds, generate three tiers:
1. **Titles only** (~3 MB gzipped): path + title + framework -- loads instantly
2. **With abstracts** (~8 MB gzipped): adds abstract snippets -- loads on demand
3. **Full content** (~50 MB+ gzipped): full body text -- optional download

The client loads tier 1 immediately, tier 2 on first search keystroke, tier 3 never (static builds don't have full-text body search; use dev server for that).

### 7.3 Alternative: WebAssembly SQLite

For advanced static deployments, bundle sql.js (SQLite compiled to WASM) with a pre-built FTS5 database. This gives full server-quality search in the browser:

```javascript
// Future enhancement: WASM SQLite search
import initSqlJs from 'sql.js'

const SQL = await initSqlJs()
const db = new SQL.Database(await fetch('/search.db').then(r => r.arrayBuffer()))
const results = db.exec("SELECT * FROM pages_fts WHERE pages_fts MATCH ?", [query])
```

This is a larger download (~15-20 MB for the FTS5 database) but provides the exact same search quality as the CLI. Worth investigating as a Phase 6 enhancement.

---

## 8. Performance Targets

| Metric | Target |
|--------|--------|
| First page load | < 200ms (dev), < 100ms (static + CDN) |
| Search index load (tier 1) | < 500ms on 3G |
| Search response (dev) | < 50ms (SQLite FTS5) |
| Search response (static) | < 100ms (client-side JS) |
| Full site build (330K pages) | < 10 minutes |
| Total static site size | ~2-5 GB (all HTML pages) |
| Deployment artifact (gzipped) | ~300-500 MB |

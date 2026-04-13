# Phase 7: Static Website

> **Goal**: Generate a fully static, deployable documentation website with client-side dynamic search from the same corpus that powers CLI and MCP.

## Architecture Decision: Static HTML + Vanilla JS

No React, no SPA, no build toolchain. The website is:
- Pre-rendered HTML pages from the normalized content model
- Vanilla JavaScript for client-side search
- CSS with system font stack, light/dark mode
- Web Worker for search indexing/scoring
- Deployable to any static hosting (GitHub Pages, Cloudflare Pages, Vercel, S3)

This aligns with the zero-dependency philosophy and keeps the website fast, simple, and maintainable.

## Exit Criteria

- [ ] `apple-docs web build` generates a complete static site in `dist/web/`
- [ ] `apple-docs web serve` starts a local preview server
- [ ] `apple-docs web deploy` prints deployment instructions per platform
- [ ] Every document in corpus has a corresponding HTML page
- [ ] Client-side search works offline after initial page load
- [ ] Search is fast (< 100ms for typical queries in browser)
- [ ] Light/dark mode with system preference detection
- [ ] Responsive design (mobile-friendly)
- [ ] Total build time < 10 minutes for full corpus

---

## Output Structure

```
dist/web/
├── index.html                          # Landing page with search
├── assets/
│   ├── style.css                       # Main stylesheet
│   ├── search.js                       # Search UI logic
│   └── theme.js                        # Light/dark mode toggle
├── docs/                               # Pre-rendered documentation pages
│   ├── documentation/
│   │   ├── swiftui/
│   │   │   ├── index.html              # SwiftUI framework page
│   │   │   ├── view/index.html         # View protocol page
│   │   │   └── ...
│   │   ├── foundation/
│   │   └── ...
│   ├── design/                         # HIG pages
│   ├── swift-evolution/                # SE proposals
│   ├── wwdc/                           # WWDC sessions
│   └── ...
├── data/
│   ├── manifest.json                   # Site metadata, framework list
│   ├── search/
│   │   ├── title-index.json            # Compact title index (loaded eagerly)
│   │   ├── aliases.json                # Framework aliases
│   │   ├── shards/                     # Body search shards (loaded on demand)
│   │   │   ├── a-c.json
│   │   │   ├── d-f.json
│   │   │   └── ...
│   │   └── snippets/                   # Pre-computed snippets per framework
│   │       ├── swiftui.json
│   │       └── ...
│   └── frameworks/                     # Per-framework metadata
│       ├── swiftui.json
│       └── ...
└── worker/
    └── search-worker.js                # Web Worker for search
```

## Tasks

### 7.1 — HTML Page Template

**File to create**: `src/web/templates.js`

```js
/**
 * Render a document page to full HTML.
 * @param {NormalizedDocument} doc
 * @param {NormalizedSection[]} sections
 * @param {object} siteConfig - { baseUrl, siteName, buildDate }
 * @returns {string} - Complete HTML page
 */
export function renderDocumentPage(doc, sections, siteConfig) {
  const contentHtml = renderHtml(doc, sections); // From Phase 1 renderer
  const breadcrumbs = buildBreadcrumbs(doc.key);
  const relatedDocs = getRelatedDocs(doc.key);

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(doc.title)} — ${siteConfig.siteName}</title>
  <meta name="description" content="${escapeHtml(doc.abstract_text || '')}">
  <link rel="stylesheet" href="${siteConfig.baseUrl}/assets/style.css">
  <script defer src="${siteConfig.baseUrl}/assets/theme.js"></script>
</head>
<body>
  <header>
    <nav>
      <a href="${siteConfig.baseUrl}/" class="site-name">${siteConfig.siteName}</a>
      <div class="search-container">
        <input type="search" id="search-input" placeholder="Search documentation..." autocomplete="off">
        <div id="search-results" class="search-dropdown" hidden></div>
      </div>
      <button id="theme-toggle" aria-label="Toggle theme"></button>
    </nav>
  </header>

  <main>
    <nav class="breadcrumbs">${breadcrumbs}</nav>

    <article>
      <div class="doc-meta">
        ${doc.framework ? `<span class="framework-badge">${doc.framework}</span>` : ''}
        ${doc.role_heading ? `<span class="kind-badge">${doc.role_heading}</span>` : ''}
        ${doc.source_type !== 'apple-docc' ? `<span class="source-badge">${doc.source_type}</span>` : ''}
      </div>

      ${contentHtml}
    </article>

    ${relatedDocs.length > 0 ? renderRelatedSidebar(relatedDocs) : ''}
  </main>

  <footer>
    <p>Built with <a href="https://github.com/g-cqd/apple-docs">apple-docs</a> on ${siteConfig.buildDate}</p>
  </footer>

  <script defer src="${siteConfig.baseUrl}/assets/search.js"></script>
</body>
</html>`;
}
```

### 7.2 — Static Site Builder

**File to create**: `src/web/build.js`

```js
/**
 * Build complete static site from corpus.
 * @param {object} ctx - { db, config, logger }
 * @param {object} options - { out, baseUrl }
 */
export async function buildStaticSite(ctx, options) {
  const outDir = options.out || 'dist/web';
  const siteConfig = { baseUrl: options.baseUrl || '', siteName: 'Apple Developer Docs', buildDate: new Date().toISOString().split('T')[0] };

  ctx.logger.info('Building static site...');

  // 1. Create directory structure
  await createDirs(outDir);

  // 2. Copy static assets
  await copyAssets(outDir);

  // 3. Build landing page
  await buildLandingPage(outDir, siteConfig, ctx);

  // 4. Build document pages (batched for memory efficiency)
  const totalDocs = ctx.db.getDocumentCount();
  let built = 0;
  const batchSize = 500;

  for (let offset = 0; offset < totalDocs; offset += batchSize) {
    const docs = ctx.db.getDocumentsBatch(offset, batchSize);
    await Promise.all(docs.map(async (doc) => {
      const sections = ctx.db.getSections(doc.id);
      const html = renderDocumentPage(doc, sections, siteConfig);
      const filePath = `${outDir}/docs/${doc.key}/index.html`;
      await Bun.write(filePath, html);
      built++;
    }));
    ctx.logger.info(`Built ${built}/${totalDocs} pages`);
  }

  // 5. Build search index artifacts
  await buildSearchArtifacts(outDir, ctx);

  // 6. Build framework metadata
  await buildFrameworkMetadata(outDir, ctx);

  // 7. Build manifest
  await buildManifest(outDir, ctx, siteConfig);

  ctx.logger.info(`Static site built: ${outDir} (${totalDocs} pages)`);
}
```

### 7.3 — Client-Side Search

**File to create**: `src/web/assets/search.js`

Search UI: debounced input, dropdown results, keyboard navigation.

```js
// search.js — Client-side search for static site

const worker = new Worker('/worker/search-worker.js');
const input = document.getElementById('search-input');
const results = document.getElementById('search-results');

let debounceTimer;

input.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const query = input.value.trim();
    if (query.length < 2) { results.hidden = true; return; }
    worker.postMessage({ type: 'search', query, limit: 10 });
  }, 150);
});

worker.addEventListener('message', (event) => {
  const { type, results: hits } = event.data;
  if (type === 'results') {
    renderResults(hits);
  }
});

function renderResults(hits) {
  if (hits.length === 0) {
    results.innerHTML = '<div class="no-results">No results found</div>';
  } else {
    results.innerHTML = hits.map(hit => `
      <a href="/docs/${hit.path}/" class="search-result">
        <span class="result-title">${highlight(hit.title, hit.matchTerms)}</span>
        <span class="result-meta">${hit.framework || ''} · ${hit.kind || ''}</span>
        ${hit.snippet ? `<span class="result-snippet">${hit.snippet}</span>` : ''}
      </a>
    `).join('');
  }
  results.hidden = false;
}
```

### 7.4 — Search Web Worker

**File to create**: `src/web/worker/search-worker.js`

The worker loads search index shards and performs scoring:

```js
// search-worker.js — Runs off-thread for non-blocking search

let titleIndex = null;  // Loaded eagerly
let aliases = null;
let bodyShards = {};    // Loaded on demand

self.addEventListener('message', async (event) => {
  const { type, query, limit } = event.data;

  if (type === 'init') {
    titleIndex = await loadIndex('/data/search/title-index.json');
    aliases = await loadIndex('/data/search/aliases.json');
    return;
  }

  if (type === 'search') {
    const results = search(query, limit);
    self.postMessage({ type: 'results', results });
  }
});

function search(query, limit = 10) {
  const terms = tokenize(query);

  // Stage 1: Exact title/path match
  let hits = exactMatch(titleIndex, query);
  if (hits.length >= limit) return hits.slice(0, limit);

  // Stage 2: Alias expansion
  const expandedTerms = expandAliases(terms, aliases);

  // Stage 3: Title BM25-like scoring
  hits = hits.concat(titleSearch(titleIndex, expandedTerms));
  hits = deduplicate(hits);
  if (hits.length >= limit) return hits.slice(0, limit);

  // Stage 4: Load body shards on demand
  const shardKeys = getRelevantShards(expandedTerms);
  for (const key of shardKeys) {
    if (!bodyShards[key]) {
      bodyShards[key] = loadShardSync(key); // or await
    }
    hits = hits.concat(bodySearch(bodyShards[key], expandedTerms));
  }

  return deduplicate(hits).slice(0, limit);
}
```

### 7.5 — Search Artifact Generation

**File to create**: `src/web/search-artifacts.js`

Generate sharded search data for the worker:

```js
export async function buildSearchArtifacts(outDir, ctx) {
  // 1. Title index — compact format
  // [[path, title, abstract_truncated, framework_index], ...]
  const frameworks = ctx.db.getFrameworkList();
  const fwIndex = Object.fromEntries(frameworks.map((f, i) => [f.slug, i]));

  const titleIndex = ctx.db.getAllDocuments().map(doc => [
    doc.key,
    doc.title,
    (doc.abstract_text || '').slice(0, 80),
    fwIndex[doc.framework] ?? -1
  ]);

  await Bun.write(`${outDir}/data/search/title-index.json`, JSON.stringify(titleIndex));
  // Estimated: ~330K entries × ~80 bytes = ~26 MB uncompressed, ~4-6 MB gzipped

  // 2. Aliases
  const aliases = ctx.db.getFrameworkSynonyms();
  await Bun.write(`${outDir}/data/search/aliases.json`, JSON.stringify(aliases));

  // 3. Body shards — partitioned by first letter of framework
  // Each shard: { [path]: bodyText }
  const shardMap = {};
  ctx.db.getAllDocumentsWithBody().forEach(doc => {
    const shardKey = (doc.framework?.[0] || '_').toLowerCase();
    if (!shardMap[shardKey]) shardMap[shardKey] = {};
    shardMap[shardKey][doc.key] = doc.bodyText?.slice(0, 500); // Truncated for size
  });

  for (const [key, shard] of Object.entries(shardMap)) {
    await Bun.write(`${outDir}/data/search/shards/${key}.json`, JSON.stringify(shard));
  }

  // 4. Snippet data per framework
  for (const fw of frameworks) {
    const docs = ctx.db.getDocumentsByFramework(fw.slug);
    const snippets = docs.map(d => [d.key, d.abstract_text?.slice(0, 150)]);
    await Bun.write(`${outDir}/data/search/snippets/${fw.slug}.json`, JSON.stringify(snippets));
  }
}
```

### 7.6 — Dev Server (Local Preview)

**File to create**: `src/web/serve.js`

```js
// apple-docs web serve [--port 3000]
export async function startDevServer(ctx, options) {
  const port = options.port || 3000;

  Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);

      // API endpoint for dynamic search (dev mode only)
      if (url.pathname === '/api/search') {
        const query = url.searchParams.get('q');
        const results = await search(ctx, { query, limit: 10 });
        return Response.json(results);
      }

      // Serve from dist/web/ if built, or render on-the-fly
      const staticPath = `dist/web${url.pathname}`;
      const file = Bun.file(staticPath);
      if (await file.exists()) {
        return new Response(file);
      }

      // On-the-fly render for document pages
      if (url.pathname.startsWith('/docs/')) {
        const key = url.pathname.replace('/docs/', '').replace(/\/$/, '');
        const doc = ctx.db.getDocumentByKey(key);
        if (doc) {
          const sections = ctx.db.getSections(doc.id);
          const html = renderDocumentPage(doc, sections, devConfig);
          return new Response(html, { headers: { 'Content-Type': 'text/html' } });
        }
      }

      return new Response('Not Found', { status: 404 });
    }
  });

  ctx.logger.info(`Dev server running at http://localhost:${port}`);
}
```

### 7.7 — CSS Stylesheet

**File to create**: `src/web/assets/style.css`

Key design decisions:
- System font stack (no web font downloads)
- `prefers-color-scheme` for automatic light/dark
- Max-width container (720px) for readability
- Responsive: mobile-first, breakpoints at 768px and 1024px
- Code blocks with syntax-aware background colors
- Framework badge colors matching Apple's documentation style

### 7.8 — Deploy Command

**File to create**: `src/commands/web-deploy.js`

```js
// apple-docs web deploy [--platform github-pages|cloudflare|vercel|netlify]
export async function deployInstructions(ctx, options) {
  const platform = options.platform || 'github-pages';

  const instructions = {
    'github-pages': `
1. Build: apple-docs web build --base-url /apple-docs
2. Push dist/web/ to gh-pages branch
3. Or use GitHub Actions:
   - Add peaceiris/actions-gh-pages to your workflow
   - Set publish_dir: dist/web`,

    'cloudflare': `
1. Build: apple-docs web build
2. Deploy: npx wrangler pages deploy dist/web --project-name apple-docs`,

    'vercel': `
1. Build: apple-docs web build
2. Deploy: npx vercel dist/web`,

    'netlify': `
1. Build: apple-docs web build
2. Deploy: npx netlify deploy --dir dist/web --prod`
  };

  ctx.logger.info(instructions[platform]);
}
```

## Performance Targets

| Metric | Target |
|---|---|
| First page load (static + CDN) | < 100ms |
| Client-side search response | < 100ms |
| Full site build time | < 10 minutes |
| Title index download (gzipped) | < 6 MB |
| Total static site size | 2-5 GB |
| Individual page size | < 50 KB (avg) |

## Files Changed Summary

| File | Action |
|---|---|
| `src/web/templates.js` | Create |
| `src/web/build.js` | Create |
| `src/web/serve.js` | Create |
| `src/web/search-artifacts.js` | Create |
| `src/web/assets/style.css` | Create |
| `src/web/assets/search.js` | Create |
| `src/web/assets/theme.js` | Create |
| `src/web/worker/search-worker.js` | Create |
| `src/commands/web-deploy.js` | Create |
| `cli.js` | Modify (web commands) |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 330K pages = slow build | Medium | Medium | Batch rendering; parallel writes; target < 10 min |
| Search index too large for browser | Medium | Medium | Sharded loading; title-only tier is ~6 MB gzipped |
| Static site hosting costs for 2-5 GB | Low | Low | GitHub Pages is free; Cloudflare Pages generous free tier |
| HTML rendering misses edge cases | Medium | Low | Reuse Phase 1 HTML renderer; test against fixtures |

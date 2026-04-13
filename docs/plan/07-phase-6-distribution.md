# Phase 6: Distribution & Setup

> **Goal**: Match or exceed the strongest competitor's packaging. New users should go from zero to working corpus in under 60 seconds via `apple-docs setup`.

## Why Distribution Matters

Currently, users must run `apple-docs sync` which crawls Apple's API for hours. This is the single biggest barrier to adoption. cupertino solves this with pre-built databases downloadable via `setup`. kimsungwhee/apple-docs-mcp solves it with npm publishing and bundled data.

apple-docs needs both: pre-built snapshots AND npm/binary distribution.

## Exit Criteria

- [ ] `apple-docs setup` downloads a pre-built database and is usable in < 60 seconds
- [ ] GitHub Actions CI builds and publishes snapshots weekly
- [ ] Snapshot artifacts include checksums and manifest
- [ ] Multiple tiers: lite (~80 MB), standard (~120 MB), full (~400 MB)
- [ ] npm package published as `@g-cqd/apple-docs` with `apple-docs` and `apple-docs-mcp` bins
- [ ] Cross-platform binaries via `bun build --compile` for macOS (arm64/x64), Linux (x64)
- [ ] `apple-docs doctor` verifies snapshot integrity

---

## Tasks

### 6.1 — Snapshot Build Pipeline

**File to create**: `src/commands/snapshot.js`

```js
// apple-docs snapshot build [--tier lite|standard|full]
export async function buildSnapshot(ctx, options) {
  const tier = options.tier || 'standard';

  // 1. Verify corpus is complete and healthy
  const health = await checkCorpusHealth(ctx);
  if (!health.ok) throw new Error('Corpus not healthy: ' + health.issues.join(', '));

  // 2. Build snapshot database
  const snapshotDb = createSnapshotDatabase(ctx, tier);

  // 3. Generate manifest
  const manifest = {
    version: '2.0.0',
    schemaVersion: 6,
    tier,
    createdAt: new Date().toISOString(),
    sources: getSourceCounts(ctx),
    documentCount: getTotalDocuments(ctx),
    checksum: computeChecksum(snapshotDb),
    size: getFileSize(snapshotDb),
  };

  // 4. Compress
  // Use tar + gzip (Bun has built-in zlib)
  const archive = await compress(snapshotDb, manifest);

  // 5. Write to dist/
  await writeSnapshot(archive, manifest, options.out);
}
```

**Snapshot tiers**:

| Tier | Contents | Estimated Size (compressed) |
|---|---|---|
| `lite` | Metadata + FTS5 title/abstract index only | ~80 MB |
| `standard` | + trigram index + body FTS5 + normalized sections | ~120 MB |
| `full` | Standard + raw JSON files | ~400 MB |

### 6.2 — Setup Command

**File to create**: `src/commands/setup.js`

```js
// apple-docs setup [--tier lite|standard|full]
export async function setup(ctx, options) {
  const tier = options.tier || 'standard';

  // 1. Check if corpus already exists
  if (corpusExists(ctx) && !options.force) {
    ctx.logger.info('Corpus already exists. Use --force to overwrite.');
    return;
  }

  // 2. Find latest release
  const release = await fetchLatestRelease();
  ctx.logger.info(`Found release: ${release.tag} (${release.date})`);

  // 3. Download snapshot
  const assetName = `apple-docs-${tier}-${release.tag}.tar.gz`;
  const asset = release.assets.find(a => a.name === assetName);
  if (!asset) throw new Error(`No ${tier} snapshot in release ${release.tag}`);

  ctx.logger.info(`Downloading ${assetName} (${formatSize(asset.size)})...`);
  const data = await downloadWithProgress(asset.url);

  // 4. Verify checksum
  const manifest = await fetchManifest(release);
  const actualChecksum = computeChecksum(data);
  if (actualChecksum !== manifest.checksum) {
    throw new Error('Checksum mismatch! Snapshot may be corrupted.');
  }

  // 5. Extract to APPLE_DOCS_HOME
  await extract(data, ctx.config.home);

  // 6. Verify database opens and schema matches
  const db = openDatabase(ctx);
  const version = db.getSchemaVersion();
  if (version !== manifest.schemaVersion) {
    throw new Error(`Schema mismatch: expected ${manifest.schemaVersion}, got ${version}`);
  }

  ctx.logger.info(`Setup complete! ${manifest.documentCount} documents ready.`);
  ctx.logger.info('Run `apple-docs search <query>` to search.');
}
```

**Release discovery**:
```js
async function fetchLatestRelease() {
  // GitHub API: repos/{owner}/{repo}/releases/latest
  const response = await fetch('https://api.github.com/repos/g-cqd/apple-docs/releases/latest');
  return response.json();
}
```

### 6.3 — GitHub Actions CI/CD

**File to create**: `.github/workflows/ci.yml` (extend from Phase 0)
**File to create**: `.github/workflows/snapshot.yml`

#### CI Workflow (on push/PR):
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run lint
      - run: bun run typecheck
      - run: bun test
```

#### Snapshot Build Workflow (weekly):
```yaml
name: Build Snapshots
on:
  schedule:
    - cron: '0 6 * * 0'  # Every Sunday at 06:00 UTC
  workflow_dispatch: {}

jobs:
  build-snapshot:
    runs-on: macos-latest  # macOS for full API access
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2

      - name: Sync corpus
        run: bun run cli.js sync --concurrency 10 --rate 10

      - name: Build body index
        run: bun run cli.js index

      - name: Build snapshots
        run: |
          bun run cli.js snapshot build --tier lite --out dist/
          bun run cli.js snapshot build --tier standard --out dist/
          bun run cli.js snapshot build --tier full --out dist/

      - name: Create release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: snapshot-${{ github.run_number }}
          files: dist/*
          body: |
            Weekly snapshot build.
            Documents: $(bun run cli.js status --json | jq .documentCount)
```

### 6.4 — npm Publishing

**Files to modify**: `package.json`

```json
{
  "name": "@g-cqd/apple-docs",
  "version": "2.0.0",
  "bin": {
    "apple-docs": "./cli.js",
    "apple-docs-mcp": "./src/cli/mcp-entry.js"
  },
  "files": ["cli.js", "index.js", "src/", "README.md", "LICENSE"],
  "type": "module",
  "engines": { "bun": ">=1.0.0" },
  "publishConfig": { "access": "public" }
}
```

**Usage after publishing**:
```bash
# Install globally
bun add -g @g-cqd/apple-docs

# Or run directly
bunx @g-cqd/apple-docs setup
bunx @g-cqd/apple-docs search "NavigationStack"

# MCP server (for Claude Desktop, Cursor, etc.)
bunx @g-cqd/apple-docs mcp start
```

### 6.5 — Cross-Platform Binaries

**File to create**: `.github/workflows/release-binaries.yml`

```yaml
name: Build Binaries
on:
  release:
    types: [published]

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: bun-darwin-arm64
            name: apple-docs-macos-arm64
          - os: macos-13
            target: bun-darwin-x64
            name: apple-docs-macos-x64
          - os: ubuntu-latest
            target: bun-linux-x64
            name: apple-docs-linux-x64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun build --compile --target=${{ matrix.target }} cli.js --outfile ${{ matrix.name }}
      - uses: softprops/action-gh-release@v2
        with:
          files: ${{ matrix.name }}
```

### 6.6 — Auto-Update Check

**Files to modify**: `src/commands/status.js`

Add an optional update check to `status`:

```js
export async function checkForUpdates(ctx) {
  try {
    const release = await fetchLatestRelease();
    const current = ctx.db.getSnapshotVersion();
    if (release.tag !== current) {
      ctx.logger.info(`Update available: ${release.tag} (current: ${current})`);
      ctx.logger.info('Run `apple-docs setup --force` to update.');
    }
  } catch {
    // Network unavailable — skip silently
  }
}
```

### 6.7 — Snapshot Verification

**Files to modify**: `src/commands/consolidate.js` (doctor command)

Add snapshot integrity verification to `doctor`:

```js
// apple-docs doctor --verify-snapshot
export async function verifySnapshot(ctx) {
  const manifest = ctx.db.getSnapshotManifest();
  if (!manifest) {
    ctx.logger.info('No snapshot manifest found. Corpus was built locally.');
    return;
  }

  // Verify document count matches
  const actualCount = ctx.db.getDocumentCount();
  if (actualCount !== manifest.documentCount) {
    ctx.logger.warn(`Document count mismatch: expected ${manifest.documentCount}, got ${actualCount}`);
  }

  // Verify schema version
  const schemaVersion = ctx.db.getSchemaVersion();
  if (schemaVersion !== manifest.schemaVersion) {
    ctx.logger.warn(`Schema version mismatch: expected ${manifest.schemaVersion}, got ${schemaVersion}`);
  }

  ctx.logger.info('Snapshot verification complete.');
}
```

## Files Changed Summary

| File | Action |
|---|---|
| `src/commands/snapshot.js` | Create |
| `src/commands/setup.js` | Create |
| `src/commands/status.js` | Modify (auto-update check) |
| `src/commands/consolidate.js` | Modify (snapshot verification) |
| `cli.js` | Modify (setup, snapshot commands) |
| `package.json` | Modify (npm publishing config) |
| `.github/workflows/ci.yml` | Modify (extend) |
| `.github/workflows/snapshot.yml` | Create |
| `.github/workflows/release-binaries.yml` | Create |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| GitHub Releases size limits | Low | Medium | Largest tier ~400 MB; well within limits |
| Snapshot staleness (weekly builds) | Medium | Low | Users can `sync` and `update` locally between snapshots |
| npm publishing breaks zero-dep narrative | Low | Low | npm is distribution, not a dependency; runtime still zero-dep |
| Cross-platform binary size | Medium | Low | Bun compiled binaries ~50-80 MB; acceptable |

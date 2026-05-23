#!/usr/bin/env bun
/**
 * One-shot dev-environment install. Idempotent — re-running is safe.
 *
 * Installs:
 *   - npm dependencies (`bun install`)
 *   - Linked CLI binaries (`bun link`)
 *   - 7zip CLI (for archive tests)
 *   - Python `fontTools` (for font-subset tests)
 *   - Playwright Chromium (for the headless-browser worker test)
 *
 * Skips any step whose tooling is already present. Reports each step
 * with a ✓ on success or a clear remediation message on failure.
 *
 * Run: `bun run dev:setup`
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

const IS_MACOS = platform() === 'darwin'
const IS_LINUX = platform() === 'linux'

let failures = 0

function info(msg) { console.log(`  ${msg}`) }
function ok(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`) }
function skip(msg) { console.log(`  \x1b[2m·\x1b[0m ${msg} (already installed)`) }
function fail(msg, hint) {
  console.error(`  \x1b[31m✗\x1b[0m ${msg}`)
  if (hint) console.error(`    \x1b[2m${hint}\x1b[0m`)
  failures++
}
function step(label) {
  console.log(`\n\x1b[1m${label}\x1b[0m`)
}

function which(bin) {
  const r = spawnSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
  return r.status === 0
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', ...opts })
}

step('Pre-flight')
if (!which('bun')) {
  fail('bun not on PATH', 'Install Bun: curl -fsSL https://bun.sh/install | bash')
  process.exit(1)
}
ok(`bun ${spawnSync('bun', ['--version']).stdout.toString().trim()}`)

step('Install npm dependencies')
{
  const r = run('bun', ['install'])
  if (r.status === 0) ok('bun install')
  else fail('bun install failed', 'Inspect output above; common cause: network or lockfile drift.')
}

step('Link CLI binaries (apple-docs, apple-docs-mcp)')
{
  const r = run('bun', ['link'])
  if (r.status === 0) ok('bun link — apple-docs is now on ~/.bun/bin')
  else fail('bun link failed', 'Make sure ~/.bun/bin is on your PATH (Bun installer normally appends it).')
}

step('Install 7zip CLI (unblocks archive tests)')
if (which('7zz') || which('7z')) {
  skip('7zip')
} else if (IS_MACOS) {
  if (!which('brew')) {
    fail('Homebrew not on PATH', 'Install brew (https://brew.sh) and re-run, or install 7zip manually.')
  } else {
    const r = run('brew', ['install', 'sevenzip'])
    if (r.status === 0) ok('brew install sevenzip')
    else fail('brew install sevenzip failed', 'Run manually and re-execute this script.')
  }
} else if (IS_LINUX) {
  info('Linux detected — run one of these manually then re-execute:')
  info('  Debian/Ubuntu:  sudo apt install -y p7zip-full')
  info('  Fedora/RHEL:    sudo dnf install -y p7zip p7zip-plugins')
  info('  Arch:           sudo pacman -S --noconfirm p7zip')
  fail('7zip install requires sudo on Linux', 'Install manually then re-run.')
} else {
  fail(`unsupported platform: ${platform()}`)
}

step('Install Python fontTools (unblocks font-subset tests)')
if (!which('python3')) {
  fail('python3 not on PATH', 'Install Python 3 from your OS package manager or https://python.org.')
} else {
  const probe = spawnSync('python3', ['-c', 'import fontTools.subset'], { stdio: ['ignore', 'ignore', 'pipe'] })
  if (probe.status === 0) {
    skip('python3 + fontTools')
  } else if (!which('pip3')) {
    fail('pip3 not on PATH', 'Install pip (typically bundled with python3) and re-run.')
  } else {
    // `--user` avoids touching system Python; works on macOS + Linux.
    const r = run('pip3', ['install', '--user', '--quiet', 'fontTools'])
    if (r.status === 0) ok('pip3 install fontTools (user-local)')
    else fail('pip3 install fontTools failed')
  }
}

step('Install Playwright Chromium (unblocks browser worker test)')
{
  // Playwright caches under ~/Library/Caches/ms-playwright (macOS)
  // or ~/.cache/ms-playwright (Linux). Probe both.
  const macCache = join(homedir(), 'Library/Caches/ms-playwright')
  const linuxCache = join(homedir(), '.cache/ms-playwright')
  const installed = existsSync(macCache) || existsSync(linuxCache)
  if (installed) {
    skip('Playwright Chromium')
  } else {
    const r = run('bunx', ['playwright', 'install', 'chromium'])
    if (r.status === 0) ok('Playwright Chromium')
    else fail('bunx playwright install chromium failed')
  }
}

if (failures > 0) {
  console.error(`\n\x1b[31m${failures} step(s) failed.\x1b[0m Address the messages above and re-run \`bun run dev:setup\`.`)
  process.exit(1)
}

console.log('\n\x1b[32m✓ Dev environment ready.\x1b[0m')
console.log('\nNext steps:')
console.log('  apple-docs setup       # fast: install prebuilt snapshot (~60s, ~6GB)')
console.log('  apple-docs sync        # slow: crawl from scratch (~25min)')
console.log('')
console.log('After populating the corpus, every previously-gated test runs')
console.log('end-to-end. `setup` is preferred for a dev install — the snapshot')
console.log('tarball ships the extracted Apple fonts; `sync` skips font')
console.log('extraction when the fonts are already system-installed (no')
console.log('SF-Pro.ttf on disk → the 12 font-subset tests skip).')
console.log('')
console.log('Then:')
console.log('  bun run ci             # full test sweep')
console.log('  bun run audit          # + knip/jscpd/file-size/coverage')
console.log('  bun run docs:dev       # live documentation site preview')

/**
 * Load ops/.env as KEY=VALUE data (no `source`, no eval).
 *
 * Why the security song-and-dance: ops/.env carries Cloudflare API
 * tokens and the launchctl-privileged label prefix. If we `source`d
 * it as bash does by default, anything writable by another user
 * could embed `$(rm -rf /)` and run as the ops owner. Ports the
 * exact shape from ops/lib/env.sh (mode 0600, owner check, allowlist
 * of known identifier characters, quote stripping) with one notable
 * addition: every check is injectable through `deps` so tests can
 * exercise the failure paths without `chmod`'ing real files.
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { userInfo } from 'node:os'

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export const REQUIRED_VARS = Object.freeze([
  'USER_NAME', 'REPO_DIR', 'OPS_DIR', 'DATA_DIR', 'BUN_BIN', 'LABEL_PREFIX',
  'WEB_PORT', 'MCP_PORT', 'WEB_BACKEND_PORT', 'MCP_BACKEND_PORT',
  'PUBLIC_WEB_HOST', 'PUBLIC_MCP_HOST', 'CADDY_ADMIN_ADDR',
  'TUNNEL_NAME_WEB', 'TUNNEL_NAME_MCP',
  'CLOUDFLARED_CREDENTIALS_FILE_WEB', 'CLOUDFLARED_CREDENTIALS_FILE_MCP',
  'CLOUDFLARED_BIN',
])

/**
 * Names that loadEnv() derives from the parsed file. They are NOT
 * required in .env; the loader synthesises them from LABEL_PREFIX
 * and other primary vars.
 */
export const DERIVED_NAMES = Object.freeze([
  'LABEL_PROXY', 'LABEL_WEB', 'LABEL_MCP',
  'LABEL_TUNNEL_WEB', 'LABEL_TUNNEL_MCP', 'LABEL_WATCHDOG',
  'STATIC_DIR', 'APPLE_DOCS_MCP_CACHE_SCALE', 'LEGACY_LAUNCHD_LABELS',
])

export class EnvLoadError extends Error {
  constructor(message, { code, exitCode = 78 } = {}) {
    super(message)
    this.name = 'EnvLoadError'
    this.code = code
    this.exitCode = exitCode
  }
}

/**
 * @typedef {Object} LoadEnvOptions
 * @property {string} [path]                       Defaults to <opsDir>/.env
 * @property {string} [opsDir]                     Defaults to the parent of this module's directory
 * @property {boolean} [skipOwnerCheck=false]      Test-only escape hatch
 * @property {boolean} [skipModeCheck=false]       Test-only escape hatch
 * @property {{ readFile?: (p: string) => string,
 *              stat?: (p: string) => { mode: number, uid: number },
 *              currentUid?: () => number,
 *              currentUser?: () => string }} [deps]
 *
 * @typedef {Object} LoadedEnv
 * @property {Record<string, string>} vars      Every primary + derived var
 * @property {{ proxy: string, web: string, mcp: string,
 *              tunnelWeb: string, tunnelMcp: string, watchdog: string }} labels
 * @property {string} staticDir
 * @property {string} opsDir
 * @property {string} repoDir
 * @property {string} dataDir
 * @property {string} bunBin
 */

/**
 * Load + validate ops/.env. Throws EnvLoadError on any policy failure.
 *
 * @param {LoadEnvOptions} [opts]
 * @returns {LoadedEnv}
 */
export function loadEnv(opts = {}) {
  const deps = opts.deps ?? {}
  const read = deps.readFile ?? defaultRead
  const stat = deps.stat ?? defaultStat
  const currentUid = deps.currentUid ?? (() => process.getuid?.() ?? userInfo().uid)
  const currentUser = deps.currentUser ?? (() => userInfo().username)

  const opsDir = opts.opsDir ?? defaultOpsDir()
  const envPath = opts.path ?? join(opsDir, '.env')

  // Existence + ownership + mode. The bash version exits 78 (sysexits
  // EX_CONFIG) on each — we mirror that via EnvLoadError.exitCode.
  let info
  try {
    info = stat(envPath)
  } catch {
    throw new EnvLoadError(
      `${envPath} not found. Copy ops/.env.example to ops/.env and edit it.`,
      { code: 'missing' },
    )
  }

  if (!opts.skipOwnerCheck && info.uid !== currentUid()) {
    throw new EnvLoadError(
      `${envPath} owner uid is ${info.uid}, expected ${currentUid()} (${currentUser()}). Refusing to load.`,
      { code: 'wrong-owner' },
    )
  }

  // mode & 0o777 isolates the perm bits; require exactly 0600.
  if (!opts.skipModeCheck && (info.mode & 0o777) !== 0o600) {
    const observed = (info.mode & 0o777).toString(8).padStart(3, '0')
    throw new EnvLoadError(
      `${envPath} mode is 0${observed}, expected 0600. Run: chmod 0600 ${envPath}`,
      { code: 'wrong-mode' },
    )
  }

  const text = read(envPath)
  const vars = parseEnvFile(text)
  validateRequired(vars, envPath)
  applyDerived(vars)

  return {
    vars,
    labels: {
      proxy: vars.LABEL_PROXY,
      web: vars.LABEL_WEB,
      mcp: vars.LABEL_MCP,
      tunnelWeb: vars.LABEL_TUNNEL_WEB,
      tunnelMcp: vars.LABEL_TUNNEL_MCP,
      watchdog: vars.LABEL_WATCHDOG,
    },
    staticDir: vars.STATIC_DIR,
    opsDir,
    repoDir: vars.REPO_DIR,
    dataDir: vars.DATA_DIR,
    bunBin: vars.BUN_BIN,
  }
}

/**
 * Parse `KEY=VALUE` lines from an .env file. Skips comments + blanks,
 * strips matched outer single/double quotes from VALUE, rejects keys
 * that aren't valid identifier shapes (defense against header smuggling).
 *
 * Exposed for tests.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  const out = {}
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.replace(/^\s+/, '')
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    let value = line.slice(eq + 1)
    if (!KEY_RE.test(key)) continue
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1)
      }
    }
    out[key] = value
  }
  return out
}

function validateRequired(vars, envPath) {
  const missing = REQUIRED_VARS.filter(k => !vars[k] || vars[k].length === 0)
  if (missing.length > 0) {
    throw new EnvLoadError(
      `required variables are unset in ${envPath}: ${missing.join(', ')}`,
      { code: 'missing-required' },
    )
  }
}

function applyDerived(vars) {
  const prefix = vars.LABEL_PREFIX
  vars.LABEL_PROXY = `${prefix}.proxy`
  vars.LABEL_WEB = `${prefix}.web`
  vars.LABEL_MCP = `${prefix}.mcp`
  vars.LABEL_TUNNEL_WEB = `${prefix}.cloudflared.web`
  vars.LABEL_TUNNEL_MCP = `${prefix}.cloudflared.mcp`
  vars.LABEL_WATCHDOG = `${prefix}.watchdog`
  vars.STATIC_DIR = vars.STATIC_DIR || `${vars.REPO_DIR}/dist/web`
  vars.APPLE_DOCS_MCP_CACHE_SCALE = vars.APPLE_DOCS_MCP_CACHE_SCALE || '1'
  vars.LEGACY_LAUNCHD_LABELS = vars.LEGACY_LAUNCHD_LABELS || ''
}

function defaultOpsDir() {
  return pathResolve(dirname(new URL(import.meta.url).pathname), '..')
}

function defaultRead(p) {
  return readFileSync(p, 'utf8')
}

function defaultStat(p) {
  const s = statSync(p)
  return { mode: s.mode, uid: s.uid }
}

/**
 * Render an ops template (.tpl) by substituting only an explicit
 * allowlist of variables. Replaces ops/lib/render.sh.
 *
 * Why an allowlist instead of `envsubst $(env | cut -d= -f1)`:
 * the templates may legitimately contain `${SOMETHING}` strings that
 * are NOT meant to be substituted (e.g. shell parameter expansions
 * embedded in a launchd plist's ProgramArguments). An allowlist makes
 * the rendering explicit: anything not on the list passes through
 * untouched, anything on the list MUST be present in the env (or the
 * caller decides whether that's an error or just a warning).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * The canonical allowlist, mirroring ops/lib/render.sh's ALLOWED_VARS.
 * Exported so render-all.js (and tests) can use the same shape.
 */
export const ALLOWED_VARS = Object.freeze([
  'USER_NAME', 'REPO_DIR', 'OPS_DIR', 'DATA_DIR', 'BUN_BIN', 'STATIC_DIR',
  'LABEL_PREFIX', 'LABEL_PROXY', 'LABEL_WEB', 'LABEL_MCP',
  'LABEL_TUNNEL_WEB', 'LABEL_TUNNEL_MCP', 'LABEL_WATCHDOG',
  'WEB_PORT', 'MCP_PORT', 'WEB_BACKEND_PORT', 'MCP_BACKEND_PORT',
  'PUBLIC_WEB_HOST', 'PUBLIC_MCP_HOST', 'CADDY_ADMIN_ADDR',
  'TUNNEL_NAME_WEB', 'TUNNEL_NAME_MCP',
  'CLOUDFLARED_CREDENTIALS_FILE_WEB', 'CLOUDFLARED_CREDENTIALS_FILE_MCP',
  'CLOUDFLARED_BIN', 'APPLE_DOCS_MCP_CACHE_SCALE',
])

/**
 * @typedef {Object} RenderResult
 * @property {string} content      The rendered text
 * @property {string[]} unresolved Keys that were referenced but not in env
 * @property {string[]} ignored    Placeholders skipped because they were not on the allowlist
 */

/**
 * Render a template string.
 *
 * @param {string} template
 * @param {Record<string, string>} env       primary + derived vars
 * @param {{ allowed?: readonly string[] }} [opts]
 * @returns {RenderResult}
 */
export function renderTemplateString(template, env, opts = {}) {
  const allowed = new Set(opts.allowed ?? ALLOWED_VARS)
  const unresolved = []
  const ignored = []
  const content = template.replace(PLACEHOLDER_RE, (match, key) => {
    if (!allowed.has(key)) {
      ignored.push(key)
      return match
    }
    if (env[key] == null || env[key] === '') {
      unresolved.push(key)
      return match
    }
    return env[key]
  })
  // De-duplicate (preserve insertion order).
  return {
    content,
    unresolved: Array.from(new Set(unresolved)),
    ignored: Array.from(new Set(ignored)),
  }
}

/**
 * Render a template file to disk.
 *
 * @param {string} templatePath
 * @param {string} outputPath
 * @param {Record<string, string>} env
 * @param {{ allowed?: readonly string[],
 *           deps?: { readFile?: (p: string) => string,
 *                    writeFile?: (p: string, content: string) => void,
 *                    ensureDir?: (p: string) => void } }} [opts]
 * @returns {RenderResult}
 */
export function renderTemplate(templatePath, outputPath, env, opts = {}) {
  const deps = opts.deps ?? {}
  const read = deps.readFile ?? defaultRead
  const write = deps.writeFile ?? defaultWrite
  const ensureDir = deps.ensureDir ?? defaultEnsureDir

  if (!opts.deps?.readFile && !existsSync(templatePath)) {
    throw new Error(`render-template: template not found at ${templatePath}`)
  }

  const text = read(templatePath)
  const result = renderTemplateString(text, env, { allowed: opts.allowed })
  ensureDir(dirname(outputPath))
  write(outputPath, result.content)
  return result
}

function defaultRead(p) { return readFileSync(p, 'utf8') }
function defaultWrite(p, content) { writeFileSync(p, content) }
function defaultEnsureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }) }

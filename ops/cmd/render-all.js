/**
 * Render every *.tpl under ops/ to its sibling rendered file.
 *
 * Ports ops/bin/render-all.sh. For launchd plists we apply a name
 * mapping so the committed filename (label-agnostic, e.g.
 * apple-docs.web.plist.tpl) lands at its label-prefixed counterpart
 * (e.g. mt.everest.apple-docs.web.plist) — that's what
 * install-daemons.js looks for. Every other template (Caddyfile,
 * cloudflared yaml, sudoers) just drops the .tpl suffix.
 *
 * CLI shape:
 *   ops/cli.js render-all [--check] [--dry-run]
 *     --check     exit 1 if any output would differ from current
 *                 on-disk content (drift detection for deploy-update)
 *     --dry-run   print what would render but don't write
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadEnv } from '../lib/env.js'
import { createLogger } from '../lib/logger.js'
import { ALLOWED_VARS, renderTemplateString } from '../lib/render-template.js'

const LAUNCHD_NAME_MAP = Object.freeze({
  'apple-docs.proxy.plist.tpl': 'LABEL_PROXY',
  'apple-docs.web.plist.tpl': 'LABEL_WEB',
  'apple-docs.mcp.plist.tpl': 'LABEL_MCP',
  'apple-docs.watchdog.plist.tpl': 'LABEL_WATCHDOG',
  'cloudflared.apple-docs.plist.tpl': 'LABEL_TUNNEL_WEB',
  'cloudflared.apple-docs-mcp.plist.tpl': 'LABEL_TUNNEL_MCP',
})

/**
 * @param {{ args: string[], deps?: object }} ctx
 * @returns {Promise<number>}
 */
export default async function runRenderAll(ctx = {}) {
  const args = new Set(ctx.args ?? [])
  const check = args.has('--check')
  const dryRun = args.has('--dry-run')

  const env = ctx.envLoader ? ctx.envLoader() : loadEnv()
  const logger = ctx.logger ?? createLogger()
  const fs = ctx.fs ?? defaultFs()

  const opsDir = env.opsDir
  const templates = findTemplates(opsDir, fs)
  if (templates.length === 0) {
    logger.warn(`render-all: no *.tpl files under ${opsDir}`)
    return 0
  }

  let drift = 0
  let rendered = 0
  for (const tpl of templates) {
    const outPath = resolveOutput(tpl, opsDir, env.vars, logger)
    const text = fs.readFile(tpl)
    const result = renderTemplateString(text, env.vars, { allowed: ALLOWED_VARS })
    if (result.unresolved.length > 0) {
      logger.warn(`render-all: unresolved vars in ${tpl}: ${result.unresolved.join(', ')}`)
    }
    if (check) {
      const existing = fs.tryReadFile(outPath) ?? ''
      if (existing !== result.content) {
        logger.warn(`drift: ${outPath}`)
        drift++
      }
    } else if (dryRun) {
      logger.say(`dry-run: ${tpl} → ${outPath} (${result.content.length} bytes)`)
    } else {
      fs.write(outPath, result.content)
      logger.say(`rendered: ${tpl} → ${outPath}`)
      rendered++
    }
  }

  if (check) {
    logger.say(`render-all --check: ${drift} drift entries across ${templates.length} templates`)
    return drift > 0 ? 1 : 0
  }
  if (!dryRun) logger.say(`render-all: ${rendered} of ${templates.length} templates rendered`)
  return 0
}

/**
 * Resolve a template's output path. Exposed so tests can pin the
 * mapping logic without mocking the full env.
 *
 * @param {string} tpl       absolute template path
 * @param {string} opsDir    ops root directory
 * @param {Record<string,string>} vars
 * @param {{ warn: Function }} [log]
 * @returns {string}
 */
export function resolveOutput(tpl, opsDir, vars, log) {
  const launchdDir = join(opsDir, 'launchd')
  const base = tpl.slice(tpl.lastIndexOf('/') + 1)
  const dir = tpl.slice(0, tpl.lastIndexOf('/'))
  if (dir === launchdDir && base !== 'sudoers.apple-docs-launchctl.tpl') {
    const labelVar = LAUNCHD_NAME_MAP[base]
    if (labelVar) {
      return join(dir, `${vars[labelVar]}.plist`)
    }
    log?.warn?.(`render-all: unknown launchd template ${base} — rendering at default path`)
  }
  return tpl.replace(/\.tpl$/, '')
}

/**
 * Recursive *.tpl discovery — exposed for tests.
 *
 * @param {string} root
 * @param {{ readdir: Function, stat: Function }} fs
 * @returns {string[]} sorted absolute paths
 */
export function findTemplates(root, fs) {
  const out = []
  walk(root, fs, out)
  out.sort()
  return out
}

function walk(dir, fs, out) {
  let entries
  try { entries = fs.readdir(dir) } catch { return }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, fs, out)
    else if (entry.isFile() && full.endsWith('.tpl')) out.push(full)
  }
}

function defaultFs() {
  return {
    readdir: (d) => readdirSync(d, { withFileTypes: true }),
    stat: (p) => statSync(p),
    readFile: (p) => readFileSync(p, 'utf8'),
    tryReadFile: (p) => {
      try { return readFileSync(p, 'utf8') } catch { return null }
    },
    write: (p, content) => {
      const dir = dirname(p)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(p, content)
    },
  }
}

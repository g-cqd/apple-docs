// Framework listing page renderer (the `/docs/<root>/index.html` shell
// for each catalogued framework).
//
// Tree data is written to a content-hashed sibling file under
// /data/frameworks/<slug>/ so edge caches can hold it indefinitely (the
// hash invalidates on rebuild). The framework HTML carries only a
// `data-tree-src` reference — inlining the tree (~800 KB on Swift stdlib,
// ~500 KB on UIKit) would dominate the HTML payload and defeat caching.

import { dirname, join } from 'node:path'
import { renderFrameworkPage, buildFrameworkTreeData } from '../templates.js'
import { ensureDir } from '../../storage/files.js'
import { sha256 } from '../../lib/hash.js'
import { maybePrecompress, PRECOMPRESS_THRESHOLD } from './io.js'

/**
 * Build every framework listing page. Returns the count of frameworks
 * that produced output (skipped frameworks with zero docs are excluded).
 */
export async function buildFrameworkPages({ roots, db, buildDir, siteConfig }) {
  let frameworksBuilt = 0
  for (const root of roots) {
    const docs = db.db.query(
      'SELECT key, title, kind, role, role_heading, abstract_text FROM documents WHERE framework = ? ORDER BY title',
    ).all(root.slug)
    if (docs.length === 0) continue

    const treeEdges = db.getFrameworkTree(root.slug)
    let treeDataUrl = null
    const tree = buildFrameworkTreeData(root, docs, treeEdges, siteConfig)
    if (tree.hasTree) {
      const hash = sha256(tree.json).slice(0, 10)
      const treeRel = `data/frameworks/${root.slug}/tree.${hash}.json`
      const treeAbs = join(buildDir, treeRel)
      ensureDir(dirname(treeAbs))
      await Bun.write(treeAbs, tree.json)
      treeDataUrl = `${siteConfig.baseUrl || ''}/${treeRel}`
    }

    const html = renderFrameworkPage(root, docs, siteConfig, { treeEdges, treeDataUrl })
    const fwFilePath = join(buildDir, 'docs', root.slug, 'index.html')
    ensureDir(dirname(fwFilePath))
    await Bun.write(fwFilePath, html)
    await maybePrecompress(fwFilePath, html)
    // The tree-data JSON is also a big static file — precompress if it
    // beats the threshold so Caddy can serve `.br` directly.
    if (treeDataUrl && tree.json.length >= PRECOMPRESS_THRESHOLD) {
      const treeRel = treeDataUrl.replace(`${siteConfig.baseUrl || ''}/`, '')
      await maybePrecompress(join(buildDir, treeRel), tree.json)
    }
    frameworksBuilt++
  }
  return frameworksBuilt
}

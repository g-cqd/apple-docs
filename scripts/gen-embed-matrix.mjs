/**
 * Export the potion embedding matrix into ADMX v1 artifacts (RFC 0002
 * D-0002-1). Thin CLI over src/lib/admx.js — the same code path the native
 * embedder uses for on-demand generation at consumers.
 *
 * Modes:
 *   --full    → <modelsDir>/<hfId>/matrix-v1.admx (~129 MB, NOT committed)
 *   --subset  → test/fixtures/embed-parity/matrix-subset.admx — only the
 *               rows used by test/fixtures/tokenizer-parity/cases.json
 *               (∪ the [0] pad row), small enough to commit so the CI
 *               native matrix can gate vector parity without the model.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateMatrixArtifact } from '../src/lib/admx.js'
import { resolveActiveSpec } from '../src/search/embedder.js'
import { PINNED_MODEL_FILES, verifyPinnedModelFiles } from '../src/search/model-integrity.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'test', 'fixtures')

const modes = process.argv.slice(2).filter((a) => a === '--full' || a === '--subset')
if (modes.length === 0) {
  console.error('usage: bun scripts/gen-embed-matrix.mjs [--full] [--subset]')
  process.exit(1)
}

const spec = resolveActiveSpec()
if (spec.hfId !== 'minishlab/potion-retrieval-32M') {
  throw new Error(`artifact targets the default model; unset APPLE_DOCS_EMBED_MODEL (got ${spec.hfId})`)
}

const modelsDir =
  process.env.APPLE_DOCS_MODELS_DIR ??
  join(process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs'), 'resources', 'models')

await verifyPinnedModelFiles(modelsDir, spec.hfId)
const onnxPath = join(modelsDir, spec.hfId, 'onnx', 'model.onnx')
const sourceShaHex = PINNED_MODEL_FILES[spec.hfId]['onnx/model.onnx']

for (const mode of modes) {
  let outPath
  let sparseIds = null
  if (mode === '--full') {
    outPath = join(modelsDir, spec.hfId, 'matrix-v1.admx')
  } else {
    const { cases } = JSON.parse(readFileSync(join(FIXTURES, 'tokenizer-parity', 'cases.json'), 'utf8'))
    const ids = new Set([0]) // the embedder's empty-input pad row
    for (const c of cases) for (const id of c.ids) ids.add(id)
    sparseIds = Uint32Array.from([...ids].sort((a, b) => a - b))
    outPath = join(FIXTURES, 'embed-parity', 'matrix-subset.admx')
  }
  const { rows, dims, bytes } = await generateMatrixArtifact({ onnxPath, outPath, sourceShaHex, sparseIds })
  console.log(`wrote ${outPath} (${bytes} bytes, ${rows} rows × ${dims})`)
}

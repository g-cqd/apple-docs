/**
 * Test-suite preload: keep every test offline and model-free by default.
 *
 * Model fetching is ON by default in production (APPLE_DOCS_FETCH_MODELS),
 * so a test that exercises setup/index-embeddings against a fresh dataDir
 * would otherwise reach huggingface.co for the 129 MB model. Tests that
 * specifically exercise the fetch path can flip the env back per-test.
 *
 * Not fetching is not enough on its own: a developer machine that has run
 * `apple-docs sync` already has the real 123 MB model.onnx sitting in
 * ~/.apple-docs/resources/models, and getEmbedder() will happily parse the
 * full fp32 embedding matrix out of it. `bun test --isolate` forks one
 * worker per core, so every worker that reaches the embedder pays that
 * cost simultaneously — enough to get the entire runner OOM-killed
 * (SIGKILL, exit 137, no failing test to point at) on a 16 GB machine.
 * CI never hits it because CI has no corpus and therefore no model.
 *
 * Point the model directory at a path that cannot exist so getEmbedder()
 * returns null on every machine, exactly as it does on CI. Both vars use
 * `??=`, so an explicit environment override still wins.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.APPLE_DOCS_FETCH_MODELS ??= '0'
process.env.APPLE_DOCS_MODELS_DIR ??= join(tmpdir(), 'apple-docs-test-models-absent')

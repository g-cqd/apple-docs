/**
 * Test-suite preload: keep every test offline by default.
 *
 * Model fetching is ON by default in production (APPLE_DOCS_FETCH_MODELS),
 * so a test that exercises setup/index-embeddings against a fresh dataDir
 * would otherwise reach huggingface.co for the 129 MB model. Tests that
 * specifically exercise the fetch path can flip the env back per-test.
 */
process.env.APPLE_DOCS_FETCH_MODELS ??= '0'

/**
 * Curated allowlist of official Swift packages that can be indexed without
 * any GitHub authentication. Covers Apple's open-source Swift libraries and
 * the swiftlang organization (compiler, toolchain, docs, testing).
 *
 * Keeping this list small and hand-maintained lets the default `official`
 * scope work from a clean environment — metadata comes from the public Swift
 * Package Index JSON API and README is pulled from raw.githubusercontent.com.
 */

/** @type {ReadonlyArray<{ owner: string, repo: string }>} */
export const OFFICIAL_PACKAGES = Object.freeze([
  // apple/* core Swift libraries
  { owner: 'apple', repo: 'swift-argument-parser' },
  { owner: 'apple', repo: 'swift-async-algorithms' },
  { owner: 'apple', repo: 'swift-algorithms' },
  { owner: 'apple', repo: 'swift-collections' },
  { owner: 'apple', repo: 'swift-numerics' },
  { owner: 'apple', repo: 'swift-atomics' },
  { owner: 'apple', repo: 'swift-log' },
  { owner: 'apple', repo: 'swift-metrics' },
  { owner: 'apple', repo: 'swift-distributed-tracing' },
  { owner: 'apple', repo: 'swift-crypto' },
  { owner: 'apple', repo: 'swift-certificates' },
  { owner: 'apple', repo: 'swift-asn1' },
  { owner: 'apple', repo: 'swift-nio' },
  { owner: 'apple', repo: 'swift-nio-ssl' },
  { owner: 'apple', repo: 'swift-nio-http2' },
  { owner: 'apple', repo: 'swift-nio-transport-services' },
  { owner: 'apple', repo: 'swift-http-types' },
  { owner: 'apple', repo: 'swift-system' },
  { owner: 'apple', repo: 'swift-docc-plugin' },
  { owner: 'apple', repo: 'swift-format' },
  { owner: 'apple', repo: 'swift-openapi-generator' },
  { owner: 'apple', repo: 'swift-openapi-runtime' },
  { owner: 'apple', repo: 'swift-foundation' },

  // swiftlang/* — compiler, toolchain, docs, testing
  { owner: 'swiftlang', repo: 'swift' },
  { owner: 'swiftlang', repo: 'swift-syntax' },
  { owner: 'swiftlang', repo: 'swift-package-manager' },
  { owner: 'swiftlang', repo: 'swift-docc' },
  { owner: 'swiftlang', repo: 'swift-testing' },
  { owner: 'swiftlang', repo: 'swift-evolution' },
  { owner: 'swiftlang', repo: 'swift-markdown' },
])

/**
 * Prebuilt `packages/<owner>/<repo>` keys (lowercased), matching the
 * `packageKey` shape used elsewhere in the adapter.
 */
export const OFFICIAL_PACKAGE_KEYS = Object.freeze(
  OFFICIAL_PACKAGES.map(({ owner, repo }) => `packages/${owner.toLowerCase()}/${repo.toLowerCase()}`),
)

// swift-tools-version: 6.2
// ordo-one/package-benchmark suite, compared commit-to-commit by swift-ci (instructions and allocations):
//
//   swift package --package-path Benchmarks benchmark
//
// Fixtures are generated deterministically at startup (a synthetic corpus of documents, sections, and
// relationships, plus the committed DocC golden inputs), so runs need no network or installed corpus.
import PackageDescription

let package = Package(
    name: "AppleDocsBenchmarks",
    platforms: [.macOS("15.6")],
    dependencies: [
        .package(name: "apple-docs-swift", path: ".."),
        .package(url: "https://github.com/ordo-one/benchmark.git", .upToNextMajor(from: "1.39.1"))
    ],
    targets: [
        .executableTarget(
            name: "AppleDocsBenchmarks",
            dependencies: [
                .product(name: "Benchmark", package: "benchmark"),
                .product(name: "AppleDocsCommands", package: "apple-docs-swift"),
                .product(name: "AppleDocsContent", package: "apple-docs-swift"),
                .product(name: "AppleDocsCore", package: "apple-docs-swift"),
                .product(name: "AppleDocsMCP", package: "apple-docs-swift"),
                .product(name: "AppleDocsSearch", package: "apple-docs-swift"),
                .product(name: "AppleDocsStorage", package: "apple-docs-swift"),
                .product(name: "AppleDocsWeb", package: "apple-docs-swift")
            ],
            path: "Benchmarks/AppleDocsBenchmarks",
            plugins: [.plugin(name: "BenchmarkPlugin", package: "benchmark")]
        )
    ]
)

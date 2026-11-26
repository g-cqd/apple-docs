// swift-tools-version: 6.2
// libFuzzer harnesses for apple-docs' untrusted-input parsers. Linux toolchains ship libFuzzer:
//
//   Fuzz/run.sh <target> [seconds]       (builds with -sanitize=fuzzer,address and runs on Fuzz/Corpus/<target>)
//
// Each target is an executable exporting `LLVMFuzzerTestOneInput`; it must never crash, trap, or leak on any
// input. Findings land in Fuzz/Artifacts and become regression cases.
import Foundation
import PackageDescription

// `-sanitize=fuzzer` links libFuzzer's `main`, so it applies to the harness executables only (a global
// `-Xswiftc` would also hit macro host tools); run.sh instruments every other module with ASan + coverage.
let fuzzerFlags: [String] = ProcessInfo.processInfo.environment["APPLE_DOCS_FUZZ"] == "1" ? ["-sanitize=fuzzer"] : []

let harnesses: [(name: String, dependencies: [Target.Dependency])] = [
    ("FuzzDocumentKey", [.product(name: "AppleDocsCore", package: "apple-docs-swift")]),
    (
        "FuzzDocCConverter",
        [
            .product(name: "AppleDocsContent", package: "apple-docs-swift"),
            .product(name: "AppleDocsCore", package: "apple-docs-swift")
        ]
    ),
    (
        "FuzzHTMLConverter",
        [
            .product(name: "AppleDocsContent", package: "apple-docs-swift"),
            .product(name: "AppleDocsCore", package: "apple-docs-swift")
        ]
    ),
    (
        "FuzzMarkdownConverter",
        [
            .product(name: "AppleDocsContent", package: "apple-docs-swift"),
            .product(name: "AppleDocsCore", package: "apple-docs-swift")
        ]
    ),
    ("FuzzLinkMapping", [.product(name: "AppleDocsContent", package: "apple-docs-swift")]),
    ("FuzzFTSQuery", [.product(name: "AppleDocsSearch", package: "apple-docs-swift")]),
    ("FuzzZstd", [.product(name: "AppleDocsStorage", package: "apple-docs-swift")]),
    ("FuzzWebMarkdown", [.product(name: "AppleDocsWeb", package: "apple-docs-swift")])
]

let package = Package(
    name: "AppleDocsFuzz",
    platforms: [.macOS("15.6")],
    dependencies: [.package(name: "apple-docs-swift", path: "..")],
    targets: harnesses.map { harness in
        .executableTarget(
            name: harness.name,
            dependencies: harness.dependencies,
            path: "Sources/\(harness.name)",
            swiftSettings: [.unsafeFlags(["-parse-as-library"] + fuzzerFlags)],
            linkerSettings: [.unsafeFlags(fuzzerFlags)]
        )
    }
)

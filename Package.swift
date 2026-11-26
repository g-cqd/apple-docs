// swift-tools-version: 6.4
import PackageDescription

let strictSettings: [SwiftSetting] = [
    .swiftLanguageMode(.v6),
    .enableUpcomingFeature("StrictMemorySafety"),
    .enableUpcomingFeature("ExistentialAny"),
    .enableUpcomingFeature("InferIsolatedConformances"),
    .enableUpcomingFeature("InternalImportsByDefault"),
    .enableUpcomingFeature("MemberImportVisibility"),
    .treatAllWarnings(as: .error),
    .unsafeFlags(["-Xfrontend", "-warn-long-expression-type-checking=500"])
]

let package = Package(
    name: "apple-docs",
    platforms: [.macOS("15.6")],
    products: [
        .executable(name: "apple-docs", targets: ["apple-docs"]),
        .library(name: "AppleDocsCore", targets: ["AppleDocsCore"]),
        .library(name: "AppleDocsStorage", targets: ["AppleDocsStorage"]),
        .library(name: "AppleDocsSearch", targets: ["AppleDocsSearch"]),
        .library(name: "AppleDocsContent", targets: ["AppleDocsContent"]),
        .library(name: "AppleDocsOutput", targets: ["AppleDocsOutput"]),
        .library(name: "AppleDocsSources", targets: ["AppleDocsSources"]),
        .library(name: "AppleDocsPipeline", targets: ["AppleDocsPipeline"]),
        .library(name: "AppleDocsSetup", targets: ["AppleDocsSetup"]),
        .library(name: "AppleDocsCommands", targets: ["AppleDocsCommands"]),
        .library(name: "AppleDocsMCP", targets: ["AppleDocsMCP"]),
        .library(name: "AppleDocsWeb", targets: ["AppleDocsWeb"])
    ],
    dependencies: [
        .package(url: "https://github.com/Aemi-Studio/aemi.git", revision: "32f1d61e0ee2fe19af99c1c1a040f1fbdae91d4a"),
        .package(url: "https://github.com/g-cqd/AemiJSON.git", revision: "fdcf306b1ffbbd29161df787ae2ea97e56718d2c"),
        .package(url: "https://github.com/g-cqd/AemiSearch.git", revision: "cba5a09c80117aaa6924f2f82ebbf803ba223db8"),
        .package(url: "https://github.com/g-cqd/AemiHTML.git", revision: "cd7581995a584bf960ba0555ab77e58a9a35b944"),
        .package(
            url: "https://github.com/g-cqd/AemiMarkdown.git",
            revision: "b32d5408b22bdce913a5363f75bfa41f60ae1286"
        ),
        .package(url: "https://github.com/g-cqd/AemiRegex.git", revision: "7be30789416069858a586e2c0cfc55bcd69ced14"),
        .package(url: "https://github.com/g-cqd/AemiHMMML.git", revision: "4b57d76eec14278fa0014f7995720878a4e97517"),
        .package(
            url: "https://github.com/g-cqd/AemiProtobuf.git",
            revision: "9c4418f09fa773e1cd3cde8be934fff9afa9101b"
        ),
        .package(url: "https://github.com/g-cqd/URLBuilder.git", revision: "850b231f7d40b394bde6b5aeaa8dc208dbc4e182"),
        .package(url: "https://github.com/g-cqd/HTTP.git", revision: "974a50afa7d1abd613d530e8eb49bcbb9882e9cf"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", .upToNextMinor(from: "1.8.2")),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", .upToNextMinor(from: "1.0.2"))
    ],
    targets: [
        .systemLibrary(
            name: "CSQLite",
            path: "Sources/CSQLite",
            providers: [
                .apt(["libsqlite3-dev"])
            ]
        ),
        .target(
            name: "AppleDocsCore",
            dependencies: [
                .product(name: "AemiKernel", package: "aemi"),
                .product(name: "AemiDigest", package: "aemi")
            ],
            path: "Sources/AppleDocsCore",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsStorage",
            dependencies: [
                "AppleDocsCore",
                "CSQLite",
                .product(name: "AemiIO", package: "aemi")
            ],
            path: "Sources/AppleDocsStorage",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsContent",
            dependencies: [
                "AppleDocsCore",
                .product(name: "AemiHTML", package: "AemiHTML"),
                .product(name: "AemiJSON", package: "AemiJSON"),
                .product(name: "AemiMarkdown", package: "AemiMarkdown"),
                .product(name: "AemiLexers", package: "aemi")
            ],
            path: "Sources/AppleDocsContent",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsSearch",
            dependencies: [
                "AppleDocsCore",
                "AppleDocsStorage",
                .product(name: "AemiSearch", package: "AemiSearch"),
                .product(name: "AemiProtobuf", package: "AemiProtobuf"),
                .product(name: "AemiJSON", package: "AemiJSON")
            ],
            path: "Sources/AppleDocsSearch",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsOutput",
            dependencies: [
                "AppleDocsCore",
                .product(name: "AemiJSON", package: "AemiJSON")
            ],
            path: "Sources/AppleDocsOutput",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsSources",
            dependencies: [
                "AppleDocsCore",
                "AppleDocsContent",
                .product(name: "AemiJSON", package: "AemiJSON"),
                .product(name: "AemiRegex", package: "AemiRegex"),
                .product(name: "AemiYAML", package: "AemiHMMML"),
                .product(name: "URLBuilder", package: "URLBuilder")
            ],
            path: "Sources/AppleDocsSources",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsPipeline",
            dependencies: [
                "AppleDocsCore",
                "AppleDocsContent",
                "AppleDocsSearch",
                "AppleDocsSources",
                "AppleDocsStorage"
            ],
            path: "Sources/AppleDocsPipeline",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsSetup",
            dependencies: [
                "AppleDocsCore",
                "AppleDocsPipeline",
                "AppleDocsSearch",
                "AppleDocsStorage",
                .product(name: "Subprocess", package: "swift-subprocess")
            ],
            path: "Sources/AppleDocsSetup",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsSetupDarwin",
            dependencies: [
                "AppleDocsCore",
                "AppleDocsSetup",
                "AppleDocsStorage",
                .product(name: "Subprocess", package: "swift-subprocess")
            ],
            path: "Sources/AppleDocsSetupDarwin",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsCommands",
            dependencies: [
                "AppleDocsContent",
                "AppleDocsCore",
                "AppleDocsOutput",
                "AppleDocsPipeline",
                "AppleDocsSearch",
                "AppleDocsSetup",
                "AppleDocsSetupDarwin",
                "AppleDocsStorage"
            ],
            path: "Sources/AppleDocsCommands",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsMCP",
            dependencies: [
                "AppleDocsCommands",
                "AppleDocsCore",
                "AppleDocsOutput",
                .product(name: "AemiJSON", package: "AemiJSON"),
                .product(name: "AemiJSONRPC", package: "AemiJSON"),
                .product(name: "AemiHTTP", package: "HTTP")
            ],
            path: "Sources/AppleDocsMCP",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsWeb",
            dependencies: [
                "AppleDocsCommands",
                "AppleDocsContent",
                "AppleDocsCore",
                "AppleDocsOutput",
                .product(name: "AemiHTTP", package: "HTTP"),
                .product(name: "AemiJSON", package: "AemiJSON")
            ],
            path: "Sources/AppleDocsWeb",
            swiftSettings: strictSettings
        ),
        .executableTarget(
            name: "apple-docs",
            dependencies: [
                "AppleDocsCommands",
                "AppleDocsCore",
                "AppleDocsMCP",
                "AppleDocsOutput",
                "AppleDocsSetup",
                "AppleDocsWeb",
                .product(name: "ArgumentParser", package: "swift-argument-parser")
            ],
            path: "Sources/apple-docs",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsTestSupport",
            dependencies: ["AppleDocsCore"],
            path: "Tests/AppleDocsTestSupport",
            swiftSettings: strictSettings
        ),
        .testTarget(
            name: "AppleDocsQualityTests",
            dependencies: [
                "AppleDocsCore",
                "AppleDocsTestSupport"
            ],
            path: "Tests/AppleDocsQualityTests",
            swiftSettings: strictSettings
        ),
        .testTarget(
            name: "AppleDocsCoreTests",
            dependencies: [
                "AppleDocsCore",
                "AppleDocsOutput",
                "AppleDocsSetup",
                "AppleDocsSetupDarwin",
                "AppleDocsStorage",
                "AppleDocsTestSupport"
            ],
            path: "Tests/AppleDocsCoreTests",
            swiftSettings: strictSettings
        ),
        .testTarget(
            name: "AppleDocsStorageTests",
            dependencies: [
                "AppleDocsCore",
                "AppleDocsStorage",
                "AppleDocsTestSupport"
            ],
            path: "Tests/AppleDocsStorageTests",
            swiftSettings: strictSettings
        )
    ]
)

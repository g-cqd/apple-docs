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
        .executable(name: "AppleDocsKernelsProbe", targets: ["AppleDocsKernelsProbe"]),
        .library(name: "AppleDocsCore", targets: ["AppleDocsCore"]),
        .library(name: "AppleDocsKernels", targets: ["AppleDocsKernels"]),
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
        .package(url: "https://github.com/Aemi-Studio/aemi.git", revision: "9f8d1a3eafed0ad23919b9c68d33606632ce0659"),
        .package(url: "https://github.com/g-cqd/AemiJSON.git", revision: "fb4478051725c95614e76b15ac11e9a5c6a502a3"),
        .package(url: "https://github.com/g-cqd/AemiSearch.git", revision: "3b20d77581083c6996b28663bae4c0d341cc1b2f"),
        .package(url: "https://github.com/g-cqd/AemiHTML.git", revision: "1e6b46932f423e8e9ccbb1a7de297005ead746b8"),
        .package(
            url: "https://github.com/g-cqd/AemiMarkdown.git",
            revision: "7310d84c3e05708940d5954888b26eb24b9e6a82"
        ),
        .package(url: "https://github.com/g-cqd/AemiRegex.git", revision: "1b58215ac7266f8c847065f0cb63ab1cc75b3bc9"),
        .package(url: "https://github.com/g-cqd/AemiHMMML.git", revision: "2daa7f8c91cd9aada423ae6c62cde19fcf9d6795"),
        .package(
            url: "https://github.com/g-cqd/AemiProtobuf.git",
            revision: "d8985c489aa19e285214d032ef98855b6b95f30b"
        ),
        .package(url: "https://github.com/g-cqd/URLBuilder.git", revision: "1c0819f41013f3e09aa87a90b3076d14a2525085"),
        .package(url: "https://github.com/g-cqd/HTTP.git", revision: "e18e598d3a7288343cbd857b83f6c4c9e0cab541"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", .upToNextMinor(from: "1.8.2")),
        .package(url: "https://github.com/apple/swift-collections.git", from: "1.1.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", from: "5.2.0"),
        .package(url: "https://github.com/apple/swift-system.git", from: "1.8.1"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", .upToNextMinor(from: "1.0.2"))
    ],
    targets: [
        .systemLibrary(name: "CSQLite", path: "Sources/CSQLite", providers: [.apt(["libsqlite3-dev"])]),
        .target(
            name: "CAppleDocsKernels",
            path: "Sources/CAppleDocsKernels",
            publicHeadersPath: "include",
            cSettings: [.unsafeFlags(["-O3"])]
        ),
        .target(
            name: "AppleDocsKernels",
            dependencies: ["CAppleDocsKernels"],
            path: "Sources/AppleDocsKernels",
            swiftSettings: strictSettings
        ),
        .executableTarget(
            name: "AppleDocsKernelsProbe",
            dependencies: ["AppleDocsKernels"],
            path: "Sources/AppleDocsKernelsProbe",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsCore",
            dependencies: [],
            path: "Sources/AppleDocsCore",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsStorage",
            dependencies: ["AppleDocsCore", "CSQLite", .product(name: "HTTPZstd", package: "HTTP")],
            path: "Sources/AppleDocsStorage",
            exclude: ["Resources"],
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsContent",
            dependencies: [
                "AppleDocsCore", .product(name: "AemiHTML", package: "AemiHTML"),
                .product(name: "AemiJSONCore", package: "AemiJSON"),
                .product(name: "AemiMarkdown", package: "AemiMarkdown"),
                .product(name: "AemiYAML", package: "AemiHMMML"),
                .product(name: "OrderedCollections", package: "swift-collections")
            ],
            path: "Sources/AppleDocsContent",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsSearch",
            dependencies: [
                "AppleDocsCore", "AppleDocsKernels", "AppleDocsStorage",
                .product(name: "AemiSearch", package: "AemiSearch"),
                .product(name: "AemiProtobuf", package: "AemiProtobuf"),
                .product(name: "AemiJSONCore", package: "AemiJSON"),
                .product(name: "OrderedCollections", package: "swift-collections")
            ],
            path: "Sources/AppleDocsSearch",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsOutput",
            dependencies: [
                "AppleDocsCore", .product(name: "AemiJSONCore", package: "AemiJSON"),
                .product(name: "OrderedCollections", package: "swift-collections")
            ],
            path: "Sources/AppleDocsOutput",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsSources",
            dependencies: [
                "AppleDocsContent", "AppleDocsCore", .product(name: "AemiHTML", package: "AemiHTML"),
                .product(name: "AemiJSONCore", package: "AemiJSON"),
                .product(name: "AemiRegex", package: "AemiRegex"),
                .product(name: "OrderedCollections", package: "swift-collections"),
                .product(name: "HTTPClient", package: "HTTP"), .product(name: "HTTPCore", package: "HTTP"),
                .product(name: "URLBuilder", package: "URLBuilder")
            ],
            path: "Sources/AppleDocsSources",
            exclude: ["Resources"],
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsPipeline",
            dependencies: [
                "AppleDocsCore", "AppleDocsContent", "AppleDocsSearch", "AppleDocsSources", "AppleDocsStorage",
                .product(name: "AemiDigest", package: "aemi"),
                .product(name: "AemiJSONCore", package: "AemiJSON"),
                .product(name: "OrderedCollections", package: "swift-collections")
            ],
            path: "Sources/AppleDocsPipeline",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsSetup",
            dependencies: [
                "AppleDocsCore", "AppleDocsStorage",
                .product(name: "AemiDigest", package: "aemi"),
                .product(name: "Subprocess", package: "swift-subprocess"),
                .product(name: "SystemPackage", package: "swift-system")
            ],
            path: "Sources/AppleDocsSetup",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsSetupDarwin",
            dependencies: ["AppleDocsSetup", "AppleDocsStorage"],
            path: "Sources/AppleDocsSetupDarwin",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsCommands",
            dependencies: [
                "AppleDocsContent", "AppleDocsCore", "AppleDocsOutput",
                "AppleDocsSearch", "AppleDocsSetup", "AppleDocsSetupDarwin", "AppleDocsStorage",
                .product(name: "AemiHTTP", package: "HTTP"), .product(name: "AemiJSONCore", package: "AemiJSON"),
                .product(name: "OrderedCollections", package: "swift-collections")
            ],
            path: "Sources/AppleDocsCommands",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsMCP",
            dependencies: [
                "AppleDocsCommands", "AppleDocsCore", "AppleDocsOutput", "AppleDocsSearch", "AppleDocsStorage",
                .product(name: "AemiJSONCore", package: "AemiJSON"), .product(name: "AemiJSONRPC", package: "AemiJSON"),
                .product(name: "AemiHTTP", package: "HTTP"),
                .product(name: "OrderedCollections", package: "swift-collections")
            ],
            path: "Sources/AppleDocsMCP",
            exclude: ["Resources"],
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsWeb",
            dependencies: [
                "AppleDocsCommands", "AppleDocsContent", "AppleDocsCore", "AppleDocsOutput",
                "AppleDocsSearch", "AppleDocsStorage",
                .product(name: "AemiKernel", package: "aemi"),
                .product(name: "AemiHTTP", package: "HTTP"), .product(name: "AemiJSONCore", package: "AemiJSON"),
                .product(name: "Crypto", package: "swift-crypto"),
                .product(name: "OrderedCollections", package: "swift-collections")
            ],
            path: "Sources/AppleDocsWeb",
            exclude: ["Resources"],
            swiftSettings: strictSettings
        ),
        .executableTarget(
            name: "apple-docs",
            dependencies: [
                "AppleDocsCommands", "AppleDocsCore", "AppleDocsMCP", "AppleDocsOutput", "AppleDocsPipeline",
                "AppleDocsSearch", "AppleDocsSetup", "AppleDocsSetupDarwin", "AppleDocsSources",
                "AppleDocsStorage", "AppleDocsWeb",
                .product(name: "ArgumentParser", package: "swift-argument-parser")
            ],
            path: "Sources/apple-docs",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsTestSupport",
            dependencies: [],
            path: "Tests/AppleDocsTestSupport",
            swiftSettings: strictSettings
        ),
        .testTarget(
            name: "AppleDocsQualityTests",
            dependencies: ["AppleDocsTestSupport"],
            path: "Tests/AppleDocsQualityTests",
            swiftSettings: strictSettings
        ),
        .testTarget(
            name: "AppleDocsCoreTests",
            dependencies: [
                "AppleDocsCore", "AppleDocsOutput", "AppleDocsSetup",
                "AppleDocsSetupDarwin", "AppleDocsStorage"
            ],
            path: "Tests/AppleDocsCoreTests",
            swiftSettings: strictSettings
        ),
        .testTarget(
            name: "AppleDocsStorageTests",
            dependencies: ["AppleDocsCore", "AppleDocsStorage"],
            path: "Tests/AppleDocsStorageTests",
            swiftSettings: strictSettings
        ),
        .testTarget(
            name: "AppleDocsSearchTests",
            dependencies: [
                "AppleDocsCore", "AppleDocsSearch", "AppleDocsStorage",
                .product(name: "AemiProtobuf", package: "AemiProtobuf"),
                .product(name: "AemiSearch", package: "AemiSearch")
            ],
            path: "Tests/AppleDocsSearchTests",
            swiftSettings: strictSettings
        ),
        .testTarget(
            name: "AppleDocsMCPTests",
            dependencies: [
                "AppleDocsCommands", "AppleDocsCore", "AppleDocsMCP", "AppleDocsOutput", "AppleDocsSearch",
                "AppleDocsStorage",
                .product(name: "AemiHTTP", package: "HTTP"), .product(name: "AemiJSONCore", package: "AemiJSON"),
                .product(name: "AemiJSONRPC", package: "AemiJSON"),
                .product(name: "OrderedCollections", package: "swift-collections")
            ],
            path: "Tests/AppleDocsMCPTests",
            swiftSettings: strictSettings
        ),
        .testTarget(
            name: "AppleDocsSetupTests",
            dependencies: [
                "AppleDocsCommands", "AppleDocsContent", "AppleDocsCore", "AppleDocsOutput", "AppleDocsPipeline",
                "AppleDocsSearch", "AppleDocsSetup", "AppleDocsSetupDarwin", "AppleDocsSources",
                "AppleDocsStorage"
            ],
            path: "Tests/AppleDocsSetupTests",
            swiftSettings: strictSettings
        ),
        .testTarget(
            name: "AppleDocsContentTests",
            dependencies: [
                "AppleDocsContent", "AppleDocsCore", "AppleDocsOutput",
                .product(name: "AemiJSONCore", package: "AemiJSON"),
                .product(name: "OrderedCollections", package: "swift-collections")
            ],
            path: "Tests/AppleDocsContentTests",
            resources: [.copy("Fixtures")],
            swiftSettings: strictSettings
        ),
        .testTarget(
            name: "AppleDocsKernelsTests",
            dependencies: ["AppleDocsKernels"],
            path: "Tests/AppleDocsKernelsTests",
            swiftSettings: strictSettings
        ),
        .testTarget(
            name: "AppleDocsWebTests",
            dependencies: [
                "AppleDocsCommands", "AppleDocsCore", "AppleDocsStorage", "AppleDocsWeb",
                .product(name: "AemiHTTP", package: "HTTP")
            ],
            path: "Tests/AppleDocsWebTests",
            swiftSettings: strictSettings
        )
    ]
)

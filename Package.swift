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
        .package(url: "https://github.com/Aemi-Studio/aemi.git", revision: "1567137e2c810eb489facf29d90a2c623b75d604"),
        .package(url: "https://github.com/g-cqd/AemiJSON.git", revision: "75deac170071149540c436bdab47a5c6d5520a4a"),
        .package(url: "https://github.com/g-cqd/AemiSearch.git", revision: "7fb8acb14e93af22211a6bd025d56b72f1496a5d"),
        .package(url: "https://github.com/g-cqd/AemiHTML.git", revision: "0b817d306a4c48f0818b353acbfd83175289843c"),
        .package(
            url: "https://github.com/g-cqd/AemiMarkdown.git",
            revision: "2240dc9329db6a6770cc60ecf5b14084282c17df"
        ),
        .package(url: "https://github.com/g-cqd/AemiRegex.git", revision: "792eebdcdf3a47daf8ba6ae9a1dfd4c6c5833fc4"),
        .package(url: "https://github.com/g-cqd/AemiHMMML.git", revision: "dd439204570a9969612ea009608ec39e455c6a33"),
        .package(
            url: "https://github.com/g-cqd/AemiProtobuf.git",
            revision: "3da9bdee8af8a7e2c6e1d8bb8a5525160331c473"
        ),
        .package(url: "https://github.com/g-cqd/URLBuilder.git", revision: "8799923de4b269a10a155f2e8d9584d2bd885935"),
        .package(url: "https://github.com/g-cqd/HTTP.git", revision: "dd39e7ecc2bfb8bf9980632517c8c549e895c34c"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", .upToNextMinor(from: "1.8.2")),
        .package(url: "https://github.com/apple/swift-collections.git", from: "1.1.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", from: "5.2.0"),
        .package(url: "https://github.com/apple/swift-system.git", from: "1.8.1"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", .upToNextMinor(from: "1.0.2"))
    ],
    targets: [
        .systemLibrary(name: "CSQLite", path: "Sources/CSQLite", providers: [.apt(["libsqlite3-dev"])]),
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
                "AppleDocsCore", "AppleDocsStorage", .product(name: "AemiSearch", package: "AemiSearch"),
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
                "AppleDocsContent", "AppleDocsCore", .product(name: "AemiJSONCore", package: "AemiJSON"),
                .product(name: "AemiRegex", package: "AemiRegex"),
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
                .product(name: "AemiDigest", package: "aemi")
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

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
        .package(url: "https://github.com/Aemi-Studio/aemi.git", revision: "04cfb910446f446476c0c853317931f3444b1323"),
        .package(url: "https://github.com/g-cqd/AemiJSON.git", revision: "a7bb9cc463fd1a7f58a404ce28dbbee6b7ee7fe7"),
        .package(url: "https://github.com/g-cqd/AemiSearch.git", revision: "5ea4a7e4678bc562ec92209a0308f74595ffd6c6"),
        .package(url: "https://github.com/g-cqd/AemiHTML.git", revision: "b430df36f2f7328cbaa4a49e3c0f0234fd0d365c"),
        .package(
            url: "https://github.com/g-cqd/AemiMarkdown.git",
            revision: "4448cefa9eb7fc97e5f3161807631592d6f4ba29"
        ),
        .package(url: "https://github.com/g-cqd/AemiRegex.git", revision: "2b6cd82b452720dc2cb75cf56a6aa085a260415a"),
        .package(url: "https://github.com/g-cqd/AemiHMMML.git", revision: "37aa42a4a121ad2e50177d5310794a44d46bb995"),
        .package(
            url: "https://github.com/g-cqd/AemiProtobuf.git",
            revision: "a6101980fe55ad2195bf1f6133fbe9fe7e8490b9"
        ),
        .package(url: "https://github.com/g-cqd/URLBuilder.git", revision: "ba70f7874bf163b3dbdaf12e43f33df700906aee"),
        .package(url: "https://github.com/g-cqd/HTTP.git", revision: "4d56dd0468f8087876bc5f33815858b6f42a5fbb"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", .upToNextMinor(from: "1.8.2")),
        .package(url: "https://github.com/apple/swift-collections.git", from: "1.1.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", from: "5.2.0"),
        .package(url: "https://github.com/apple/swift-system.git", from: "1.8.1"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", .upToNextMinor(from: "1.0.2"))
    ],
    targets: [
        .systemLibrary(name: "CSQLite", path: "Sources/CSQLite", providers: [.apt(["libsqlite3-dev"])]),
        .target(
            name: "CAppleDocsZstd",
            path: "Sources/CAppleDocsZstd",
            exclude: ["LICENSE", "VENDORED.md"]
        ),
        .target(
            name: "AppleDocsCore",
            dependencies: [],
            path: "Sources/AppleDocsCore",
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsStorage",
            dependencies: ["AppleDocsCore", "CSQLite", "CAppleDocsZstd"],
            path: "Sources/AppleDocsStorage",
            resources: [.process("Resources")],
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
                "AppleDocsCore", .product(name: "AemiRegex", package: "AemiRegex"),
                .product(name: "URLBuilder", package: "URLBuilder")
            ],
            path: "Sources/AppleDocsSources",
            resources: [.process("Resources")],
            swiftSettings: strictSettings
        ),
        .target(
            name: "AppleDocsPipeline",
            dependencies: [
                "AppleDocsCore", "AppleDocsContent", "AppleDocsSearch", "AppleDocsSources", "AppleDocsStorage",
                .product(name: "AemiSearch", package: "AemiSearch")
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
            resources: [.process("Resources")],
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
            resources: [.process("Resources")],
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

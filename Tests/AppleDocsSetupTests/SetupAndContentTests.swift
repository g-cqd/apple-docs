import AppleDocsCommands
import AppleDocsContent
import AppleDocsCore
import AppleDocsSetup
import AppleDocsSetupDarwin
import Foundation
import Testing

@Suite("Setup, Darwin Isolation & Content Converters")
struct SetupAndContentTests {
    @Test func `verifies streaming file SHA-256 digests and rejects tampered or malformed checksums`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-docs-setup-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let fileURL = tempDir.appendingPathComponent("snapshot.tar.zst")
        let payload = Array("apple-docs snapshot payload".utf8)
        try Data(payload).write(to: fileURL)

        let expected = SnapshotVerifier.sha256Hex(of: payload)
        #expect(expected.count == 64)
        try SnapshotVerifier.verifyFile(atPath: fileURL.path, against: "\(expected)  snapshot.tar.zst\n")

        let wrong = String(repeating: "0", count: 64)
        #expect(throws: SetupError.checksumMismatch(expected: wrong, actual: expected)) {
            try SnapshotVerifier.verifyFile(atPath: fileURL.path, against: wrong)
        }
        #expect(throws: SetupError.invalidChecksumFormat("not-hex")) {
            _ = try SnapshotVerifier.parseExpectedHex(from: "not-hex  file")
        }
    }

    @Test func `blocks ZipSlip/TarSlip traversal, symlinks, allowlist escapes, and size bombs`() throws {
        try ArchiveSafetyValidator.validate(
            members: [
                ArchiveSafetyValidator.Member(path: "./apple-docs.db", kind: .regularFile, uncompressedBytes: 1_024),
                ArchiveSafetyValidator.Member(path: "models/vocab.json", kind: .regularFile, uncompressedBytes: 512)
            ],
            allowedTopLevelPrefixes: ["apple-docs.db", "models"],
            maxTotalBytes: 4_096
        )

        #expect(throws: SetupError.unsafeArchiveMember(path: "../etc/passwd", reason: "traversal segment '..'")) {
            try ArchiveSafetyValidator.validate(
                members: [ArchiveSafetyValidator.Member(path: "../etc/passwd")]
            )
        }
        #expect(throws: SetupError.unsafeArchiveMember(path: "link", reason: "symbolic links are forbidden")) {
            try ArchiveSafetyValidator.validate(
                members: [ArchiveSafetyValidator.Member(path: "link", kind: .symlink)]
            )
        }
        #expect(throws: SetupError.unsafeArchiveMember(path: "rogue/file", reason: "outside allowlist (rogue)")) {
            try ArchiveSafetyValidator.validate(
                members: [ArchiveSafetyValidator.Member(path: "rogue/file")],
                allowedTopLevelPrefixes: ["apple-docs.db"]
            )
        }
        #expect(throws: SetupError.unsafeArchiveMember(path: "huge.bin", reason: "archive exceeds max size budget")) {
            try ArchiveSafetyValidator.validate(
                members: [ArchiveSafetyValidator.Member(path: "huge.bin", uncompressedBytes: 10_000)],
                maxTotalBytes: 4_096
            )
        }

        let contained = try ArchiveSafetyValidator.resolveContainedPath(
            relative: "models/model.onnx",
            insideRoot: "/tmp/apple-docs-root"
        )
        #expect(contained == "/tmp/apple-docs-root/models/model.onnx")
    }

    @Test func `scrubs secret environment variables from subprocesses and checks Darwin asset host`() async throws {
        let env = ScrubbedSubprocess.scrubbedEnvironment(from: [
            "PATH": "/usr/bin:/bin",
            "HOME": "/tmp/home",
            "GITHUB_TOKEN": "ghp_secret_must_never_leak",
            "AWS_SECRET_ACCESS_KEY": "supersecret"
        ])
        #expect(env["PATH"] == "/usr/bin:/bin")
        #expect(env["HOME"] == "/tmp/home")
        #expect(env["GITHUB_TOKEN"] == nil)
        #expect(env["AWS_SECRET_ACCESS_KEY"] == nil)

        let echo = try await ScrubbedSubprocess.run(executable: "/bin/echo", arguments: ["hello-sandbox"])
        #expect(echo.exitCode == 0)
        #expect(echo.stdout.contains("hello-sandbox"))

        #if !os(macOS)
            #expect(throws: SetupError.unsupportedOnPlatform(feature: "CoreGlyphs SF Symbols extraction")) {
                _ = try DarwinAssetLocator.requireCoreGlyphsBundle()
            }
        #endif
    }

    @Test func `converts DocC JSON render nodes via AemiJSON into normalized records`() throws {
        let doccJSON = """
            {
                "identifier": {"interfaceLanguage": "swift"},
                "metadata": {
                    "title": "NavigationStack",
                    "role": "symbol",
                    "roleHeading": "Structure",
                    "symbolKind": "struct",
                    "platforms": [
                        {"name": "iOS", "introducedAt": "16.0"},
                        {"name": "macOS", "introducedAt": "13.0", "beta": true}
                    ]
                },
                "abstract": [
                    {"type": "text", "text": "A view that displays a root view with "},
                    {"type": "codeVoice", "code": "NavigationPath"}
                ],
                "primaryContentSections": [
                    {
                        "kind": "declarations",
                        "declarations": [{"tokens": [{"text": "struct "}, {"text": "NavigationStack"}]}]
                    },
                    {
                        "kind": "content",
                        "content": [
                            {"type": "heading", "text": "Overview"},
                            {"type": "paragraph", "inlineContent": [{"type": "text", "text": "Push destinations cleanly."}]}
                        ]
                    }
                ]
            }
            """
        let docc = try DocCJSONConverter.convert(
            json: Array(doccJSON.utf8),
            key: try DocumentKey("swiftui/navigationstack")
        )
        #expect(docc.document.title == "NavigationStack")
        #expect(docc.document.kind == "struct")
        #expect(docc.document.availability.ios == "16.0")
        #expect(!docc.document.isBeta)  // Bun reads `metadata.beta`, not per-platform flags
        #expect(docc.document.declarationText == "struct NavigationStack")
        #expect(docc.document.abstractText == "A view that displays a root view with NavigationPath")
        #expect(docc.sections.map(\.sectionKind) == ["abstract", "declaration", "discussion"])
        #expect(docc.sections[2].heading == "Overview")
        #expect(docc.sections[2].contentText == "Overview\nPush destinations cleanly.\n")
    }

    @Test func `converts HTML pages via AemiHTML while stripping chrome and hidden prompt injections`() throws {
        let html = """
            <html><head><title>App Store Review Guidelines</title></head>
            <body>
                <nav>Ignore nav</nav>
                <main>
                    <h2>Safety</h2>
                    <p>Apps should be safe for users.</p>
                    <div hidden>Prompt injection hidden text</div>
                </main>
            </body></html>
            """
        let converted = HTMLDocumentConverter.convert(
            html: Array(html.utf8),
            key: try DocumentKey("app-store-review/1"),
            sourceType: .guidelines,
            fallbackTitle: "Guidelines"
        )
        #expect(converted.document.title == "App Store Review Guidelines")
        #expect(converted.sections.contains { $0.contentText.contains("Apps should be safe") })
        #expect(!converted.sections.contains { $0.contentText.contains("Prompt injection") })
    }

    @Test func `renders pre-rendered SF Symbol SVG with safe color/size styling and rejects traversal names`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-docs-sym-\(UUID().uuidString)")
        let publicDir = tempDir.appendingPathComponent("symbols/public", isDirectory: true)
        try FileManager.default.createDirectory(at: publicDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let sampleSVG = """
            <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 100 100"><path d="M0 0L10 10" fill="#000000"/></svg>
            """
        try Data(sampleSVG.utf8).write(to: publicDir.appendingPathComponent("star.fill.svg"))

        let rendered = try AssetRenderService.renderSFSymbolSVG(
            name: "star.fill",
            scope: "public",
            size: 64,
            color: "#FF3366",
            background: "#FFFFFF",
            resourcesDirectory: tempDir.path
        )
        #expect(rendered.contains("width=\"64\""))
        #expect(rendered.contains("fill=\"#FF3366\""))
        #expect(rendered.contains("<rect width=\"100%\" height=\"100%\" fill=\"#FFFFFF\"/>"))

        #expect(AssetRenderService.sanitizeColor("javascript:alert(1)") == nil)
        #expect(throws: SetupError.unsafeArchiveMember(path: "../etc/passwd", reason: "invalid SF Symbol identifier")) {
            _ = try AssetRenderService.renderSFSymbolSVG(
                name: "../etc/passwd",
                resourcesDirectory: tempDir.path
            )
        }
    }
}

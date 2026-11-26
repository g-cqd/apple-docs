import AppleDocsCore
import AppleDocsSetup
import AppleDocsSetupDarwin
import AppleDocsStorage
import Foundation
import Testing

@Suite("Phase 2 Setup: SnapshotBuilder, SFNT Inspector & Darwin CoreGlyphs")
struct Phase2SetupTests {
    @Test
    func `SnapshotBuilder compacts DB with VACUUM INTO, creates .sha256, and round-trips through SnapshotInstaller`()
        async throws
    {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-docs-snap-build-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let sourceDB = tempDir.appendingPathComponent("source.db").path
        let store = try CorpusStore(path: sourceDB, options: .readWrite)
        try store.upsertDocument(DocumentRecord(key: try DocumentKey("swiftui/view"), title: "View"))
        store.close()

        let archivePath = tempDir.appendingPathComponent("corpus.tar.gz").path
        let built = try await SnapshotBuilder.create(
            databasePath: sourceDB,
            outputArchivePath: archivePath,
            compression: .gzip
        )
        #expect(built.documentCount == 1)
        #expect(built.sha256Hex.count == 64)
        #expect(built.archiveBytes > 0)
        #expect(SnapshotBuilder.hasAvailableDiskSpace(atPath: tempDir.path, minimumBytes: 1_024))

        let sidecar = try String(contentsOfFile: built.checksumPath, encoding: .utf8)
        let installDir = tempDir.appendingPathComponent("installed", isDirectory: true).path
        try await SnapshotInstaller.installLocalArchive(
            archivePath: built.archivePath,
            expectedSHA256Text: sidecar,
            into: installDir
        )

        let installedStore = try CorpusStore(
            path: URL(fileURLWithPath: installDir).appendingPathComponent("apple-docs-v1.db").path,
            options: .readOnly
        )
        defer { installedStore.close() }
        #expect(try installedStore.documentCount() == 1)
        #expect(try installedStore.document(forKey: try DocumentKey("swiftui/view"))?.title == "View")
    }

    @Test func `SFNTFontMetadata parses Apple font filenames and decodes OpenType fvar variable axes`() {
        let p1 = SFNTFontMetadata.parseAppleFilename("SF-Pro-Display-BoldItalic.otf")
        #expect(p1 == SFNTFontMetadata.ParsedName(variant: "Display", weight: "Bold", italic: true))

        let p2 = SFNTFontMetadata.parseAppleFilename("NewYorkSmall-RegularItalic.otf")
        #expect(p2 == SFNTFontMetadata.ParsedName(variant: "Small", weight: "Regular", italic: true))

        let p3 = SFNTFontMetadata.parseAppleFilename("SF-Pro.ttf")
        #expect(p3 == SFNTFontMetadata.ParsedName(variant: nil, weight: nil, italic: false))

        #expect(!SFNTFontMetadata.inspect(bytes: Array("not-a-font".utf8)).isValidSFNT)

        // Build minimal synthetic OpenType SFNT with 1 table ('fvar') and 1 axis ('wght': 100..400..900)
        var sfnt: [UInt8] = [
            0x4F, 0x54, 0x54, 0x4F,  // 'OTTO'
            0x00, 0x01,  // numTables = 1
            0x00, 0x10, 0x00, 0x00, 0x00, 0x00
        ]
        // Table record: tag='fvar', checksum=0, offset=28, length=36
        sfnt.append(contentsOf: Array("fvar".utf8))
        sfnt.append(contentsOf: [0, 0, 0, 0])
        sfnt.append(contentsOf: [0, 0, 0, 28])
        sfnt.append(contentsOf: [0, 0, 0, 36])
        // fvar header (16 bytes): major=1, minor=0, axesArrayOffset=16, reserved=2, axisCount=1, axisSize=20, ...
        sfnt.append(contentsOf: [
            0x00, 0x01, 0x00, 0x00,
            0x00, 0x10, 0x00, 0x02,
            0x00, 0x01, 0x00, 0x14,
            0x00, 0x00, 0x00, 0x00
        ])
        // Axis record (20 bytes): tag='wght', min=100.0, def=400.0, max=900.0 (16.16 fixed)
        sfnt.append(contentsOf: Array("wght".utf8))
        sfnt.append(contentsOf: encodeFixed16_16(100))
        sfnt.append(contentsOf: encodeFixed16_16(400))
        sfnt.append(contentsOf: encodeFixed16_16(900))
        sfnt.append(contentsOf: [0, 0, 0, 0])

        let info = SFNTFontMetadata.inspect(bytes: sfnt)
        #expect(info.isValidSFNT)
        #expect(info.isVariable)
        #expect(info.axes == [SFNTFontMetadata.Axis(tag: "wght", minValue: 100, defaultValue: 400, maxValue: 900)])
    }

    @Test func `DarwinCoreGlyphsSync imports symbols on macOS or throws unsupportedOnPlatform on Linux`() throws {
        let store = try CorpusStore(path: ":memory:")
        #if os(macOS)
            if let bundlePath = DarwinAssetLocator.discover().coreGlyphsBundlePath {
                let report = try DarwinCoreGlyphsSync.sync(into: store, bundlePath: bundlePath)
                #expect(report.symbolsSynced > 1_000)
                let star = try store.connection.queryOne(
                    "SELECT name FROM sf_symbols WHERE scope = 'public' AND name = 'star.fill'"
                )
                #expect(try star?.text(at: 0) == "star.fill")
            }
        #else
            #expect(throws: SetupError.unsupportedOnPlatform(feature: "CoreGlyphs SF Symbols catalog sync")) {
                _ = try DarwinCoreGlyphsSync.sync(into: store)
            }
        #endif
    }

    private func encodeFixed16_16(_ whole: Int32) -> [UInt8] {
        let raw = UInt32(bitPattern: whole << 16)
        return [
            UInt8(truncatingIfNeeded: raw >> 24),
            UInt8(truncatingIfNeeded: raw >> 16),
            UInt8(truncatingIfNeeded: raw >> 8),
            UInt8(truncatingIfNeeded: raw)
        ]
    }
}

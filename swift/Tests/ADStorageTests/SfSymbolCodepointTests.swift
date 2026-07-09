// Gates for the SF Symbol codepoint stamper (the native port of
// codepoint-stamp.js / codepoint-dump.js / symbol-codepoint-worker.js): the PUA
// validation, the version-gated worker source templates, on-disk app resolution, the
// `updateSfSymbolCodepoint` write, and — when SF Symbols.app is present on the host —
// the full in-process compile → dlopen → extract path end to end. The pure pieces run
// everywhere; the extraction test skips cleanly on a host without the app (CI without
// SF Symbols.app or `swiftc`), exactly as the stamper itself degrades.

import Foundation
import Testing

@testable import ADStorage

@Suite("SF Symbol codepoint stamping")
struct SfSymbolCodepointTests {
    // MARK: - PUA validation (the JS isPrivateUseCodepoint)

    @Test(
        "accepts the three PUA blocks, rejects everything else",
        arguments: [
            (UInt32(0xE000), true), (UInt32(0xF8FF), true),  // BMP PUA edges
            (UInt32(0xF_0000), true), (UInt32(0xF_FFFD), true),  // plane 15 edges
            (UInt32(0x10_0000), true), (UInt32(0x10_FFFD), true),  // plane 16 edges
            (UInt32(0x10199A), true),  // square.and.arrow.up
            (UInt32(0), false), (UInt32(0x41), false),  // 0 sentinel + 'A'
            (UInt32(0xDFFF), false), (UInt32(0xF900), false),  // just below/above BMP PUA
            (UInt32(0x10_FFFE), false)  // just past plane 16 PUA
        ])
    func puaValidation(value: UInt32, expected: Bool) {
        #expect(SfSymbolCodepointReader.isPrivateUseCodepoint(value) == expected)
    }

    // MARK: - Version-gated worker source (the JS v7/v8 downgrade)

    @Test("SF Symbols 8 interface grows enhancedKeywordsURL + a non-optional escaping decryptor")
    func sharedInterfaceV8() {
        let v8 = SfSymbolCodepointWorkerSource.sfSymbolsSharedInterface(major: 8)
        #expect(v8.contains("enhancedKeywordsURL: Foundation.URL?"))
        #expect(v8.contains("@escaping (CoreText.CTFont, Swift.UInt32) -> Foundation.Data?"))
        #expect(v8.contains("public init<A>(symbolFontProvider: A"))
    }

    @Test("SF Symbols 7 interface has the optional 4-parameter init and no enhancedKeywordsURL")
    func sharedInterfaceV7() {
        let v7 = SfSymbolCodepointWorkerSource.sfSymbolsSharedInterface(major: 7)
        #expect(!v7.contains("enhancedKeywordsURL"))
        #expect(v7.contains("((CoreText.CTFont, Swift.UInt32) -> Foundation.Data?)?"))
    }

    @Test("helper source gates the enhancedKeywordsURL argument on the major and exports the C ABI")
    func helperSourceGating() {
        let v8 = SfSymbolCodepointWorkerSource.helperSource(major: 8)
        let v7 = SfSymbolCodepointWorkerSource.helperSource(major: 7)
        #expect(v8.contains("enhancedKeywordsURL: nil"))
        #expect(!v7.contains("enhancedKeywordsURL"))
        for source in [v8, v7] {
            #expect(source.contains(#"@_cdecl("adsym_open")"#))
            #expect(source.contains(#"@_cdecl("adsym_lookup")"#))
            #expect(source.contains(#"@_cdecl("adsym_close")"#))
            #expect(source.contains("Crypton.decryptObfuscatedFontTable"))
        }
    }

    @Test("the CoreGlyphsLib shim declares the decryptor and the module triple matches the host arch")
    func glyphsInterfaceAndTriple() {
        #expect(SfSymbolCodepointWorkerSource.coreGlyphsLibInterface.contains("decryptObfuscatedFontTable"))
        let triple = SfSymbolCodepointWorkerSource.moduleTriple
        #expect(triple.hasSuffix("-apple-macos"))
        #if arch(x86_64)
            #expect(triple == "x86_64-apple-macos")
        #else
            #expect(triple == "arm64-apple-macos")
        #endif
    }

    // MARK: - App resolution (the JS resolveSymbolFontPath / readInstalledVersion)

    @Test("an explicit app path is authoritative — no /Applications fallback")
    func explicitPathIsAuthoritative() {
        #expect(
            SfSymbolsAppLocator.candidates(dataDir: "/data", explicitAppPath: "/custom/My.app") == ["/custom/My.app"])
    }

    @Test("without an explicit path, discovery is /Applications (both bundle names) then the cache")
    func discoveryOrder() {
        let candidates = SfSymbolsAppLocator.candidates(dataDir: nil, explicitAppPath: nil)
        #expect(candidates == SfSymbolsAppLocator.applicationsCandidates)
        #expect(candidates.contains("/Applications/SF Symbols.app"))
        #expect(candidates.contains("/Applications/SF Symbols Beta.app"))
    }

    @Test("validate returns nil for a bundle missing the font/frameworks")
    func validateMissing() {
        #expect(SfSymbolsAppLocator.validate(appPath: "/nope/Missing.app") == nil)
    }

    @Test("readInstalledVersion parses CFBundleShortVersionString, nil when the plist is absent")
    func versionRead() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("adsym-ver-\(UUID().uuidString)").appendingPathComponent("X.app")
            .appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let appPath = root.deletingLastPathComponent().path
        #expect(SfSymbolsAppLocator.readInstalledVersion(appPath: appPath) == nil)
        try Data("<plist><dict><key>CFBundleShortVersionString</key><string>8.0</string></dict></plist>".utf8)
            .write(to: root.appendingPathComponent("Info.plist"))
        #expect(SfSymbolsAppLocator.readInstalledVersion(appPath: appPath) == "8.0")
        try? FileManager.default.removeItem(at: root.deletingLastPathComponent().deletingLastPathComponent())
    }

    @Test("SfSymbolsApp.major falls back to 8 when the version is unreadable")
    func majorFallback() {
        let app = SfSymbolsApp(
            appPath: "/x", fontPath: "/x", metadataDir: "/x", sharedFrameworkDir: "/x",
            glyphsLibFrameworkDir: "/x", version: nil)
        #expect(app.major == 8)
        let seven = SfSymbolsApp(
            appPath: "/x", fontPath: "/x", metadataDir: "/x", sharedFrameworkDir: "/x",
            glyphsLibFrameworkDir: "/x", version: "7.2")
        #expect(seven.major == 7)
    }

    // MARK: - DB write (the JS assetsSymbols.updateCodepoint)

    @Test("updateSfSymbolCodepoint stamps then clears codepoint + version, keyed on (scope, name)")
    func codepointWrite() throws {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("adsym-db-\(UUID().uuidString).db").path
        defer { try? FileManager.default.removeItem(atPath: path) }
        // `writable:true` opens READWRITE without CREATE, so seed a 0-byte file (a valid empty
        // SQLite database) for the connection to open.
        #expect(FileManager.default.createFile(atPath: path, contents: nil))
        let connection = try #require(StorageConnection(path: path, writable: true))
        #expect(
            exec(
                connection,
                "CREATE TABLE sf_symbols (name TEXT, scope TEXT, codepoint INTEGER, codepoint_version TEXT, PRIMARY KEY(scope, name))"
            ))
        #expect(
            exec(
                connection,
                "INSERT INTO sf_symbols(name, scope) VALUES ('square.and.arrow.up','public'),('square.and.arrow.up','private')"
            ))

        #expect(
            connection.updateSfSymbolCodepoint(
                scope: "public", name: "square.and.arrow.up", codepoint: 0x10199A, version: "8.0"))
        #expect(readCodepoint(connection, scope: "public") == 0x10199A)
        #expect(readVersion(connection, scope: "public") == "8.0")
        // The private-scope row of the same name is untouched (PK is composite).
        #expect(readCodepoint(connection, scope: "private") == nil)

        // Clearing writes SQL NULL to both columns (the JS null branch).
        #expect(
            connection.updateSfSymbolCodepoint(
                scope: "public", name: "square.and.arrow.up", codepoint: nil, version: nil))
        #expect(readCodepoint(connection, scope: "public") == nil)
        #expect(readVersion(connection, scope: "public") == nil)
    }

    // MARK: - Full native path (host-gated: needs SF Symbols.app + swiftc)

    @Test("in-process compile → dlopen → extract yields PUA codepoints for known symbols")
    func endToEndExtraction() {
        // Host-gated: a bare host (no SF Symbols.app, or no swiftc) resolves/opens to nil → skip,
        // exactly as the stamper degrades.
        guard let app = SfSymbolsAppLocator.resolve(dataDir: nil) else { return }
        let cacheDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adsym-e2e-\(UUID().uuidString)").path
        defer { try? FileManager.default.removeItem(atPath: cacheDir) }
        guard let reader = SfSymbolCodepointReader.open(app: app, cacheDir: cacheDir) else { return }
        defer { reader.close() }
        let up = reader.lookup("square.and.arrow.up")
        #expect(up != nil)
        if let up { #expect(SfSymbolCodepointReader.isPrivateUseCodepoint(up)) }
        #expect(reader.lookup("definitely.not.a.real.symbol.zzz") == nil)
    }

    // MARK: - helpers

    private func exec(_ connection: StorageConnection, _ sql: String) -> Bool {
        guard let stmt = connection.conn.prepareUncached(sql) else { return false }
        return stmt.step() == SQLite.done
    }

    private func readCodepoint(_ connection: StorageConnection, scope: String) -> Int64? {
        guard
            let stmt = connection.conn.prepareUncached(
                "SELECT codepoint FROM sf_symbols WHERE scope='\(scope)' AND name='square.and.arrow.up'"),
            stmt.step() == SQLite.row
        else { return nil }
        return stmt.int(0)
    }

    private func readVersion(_ connection: StorageConnection, scope: String) -> String? {
        guard
            let stmt = connection.conn.prepareUncached(
                "SELECT codepoint_version FROM sf_symbols WHERE scope='\(scope)' AND name='square.and.arrow.up'"),
            stmt.step() == SQLite.row
        else { return nil }
        return stmt.text(0)
    }
}

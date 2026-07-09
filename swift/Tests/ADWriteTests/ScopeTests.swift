// ScopeLoader gate (lib/scope.js `loadScope`/`normalizeScope`): the absent-file
// nil contract, version/shape validation, source-name validation against the
// adapter registry, list normalization (trim/lowercase/dedupe/empty-collapse),
// and the keepFonts/keepSymbols `!== false` defaults.

import Foundation
import Testing

@testable import ADWrite

@Suite("ScopeLoader — scope.json loading + validation")
struct ScopeTests {
    private let validSources = ["apple-docc", "hig", "swift-book", "wwdc"]

    private func write(_ json: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adwrite-scope-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try json.write(
            to: dir.appendingPathComponent("scope.json"), atomically: true, encoding: .utf8)
        return dir
    }

    @Test("absent scope.json loads as nil")
    func absent() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adwrite-scope-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        #expect(try ScopeLoader.load(dataDir: dir.path, validSources: validSources) == nil)
    }

    @Test("a full scope normalizes: trimmed, lowercased, deduped")
    func normalization() throws {
        let dir = try write(
            """
            { "version": 1,
              "sources": [" Apple-DOCC ", "hig", "hig", ""],
              "appleDoccFrameworks": ["SwiftUI", " combine "],
              "keepSymbols": false }
            """)
        defer { try? FileManager.default.removeItem(at: dir) }
        let scope = try ScopeLoader.load(dataDir: dir.path, validSources: validSources)
        #expect(scope?.sources == ["apple-docc", "hig"])
        #expect(scope?.appleDoccFrameworks == ["swiftui", "combine"])
        #expect(scope?.keepFonts == true)
        #expect(scope?.keepSymbols == false)
    }

    @Test("invalid JSON, wrong version, and non-object shapes throw")
    func malformed() throws {
        for body in ["{ not json", "[1,2]", "{ \"version\": 2 }", "{ \"version\": true }"] {
            let dir = try write(body)
            defer { try? FileManager.default.removeItem(at: dir) }
            #expect(throws: MaintenanceError.self) {
                try ScopeLoader.load(dataDir: dir.path, validSources: validSources)
            }
        }
    }

    @Test("unknown sources and frameworks-without-apple-docc throw")
    func crossFieldValidation() throws {
        let unknown = try write("{ \"version\": 1, \"sources\": [\"not-a-source\"] }")
        defer { try? FileManager.default.removeItem(at: unknown) }
        #expect(throws: MaintenanceError.self) {
            try ScopeLoader.load(dataDir: unknown.path, validSources: validSources)
        }

        let mismatch = try write(
            "{ \"version\": 1, \"sources\": [\"hig\"], \"appleDoccFrameworks\": [\"swiftui\"] }")
        defer { try? FileManager.default.removeItem(at: mismatch) }
        #expect(throws: MaintenanceError.self) {
            try ScopeLoader.load(dataDir: mismatch.path, validSources: validSources)
        }
    }

    @Test("an all-empty list collapses to nil (no restriction)")
    func emptyList() throws {
        let dir = try write("{ \"version\": 1, \"sources\": [\" \", \"\"] }")
        defer { try? FileManager.default.removeItem(at: dir) }
        let scope = try ScopeLoader.load(dataDir: dir.path, validSources: validSources)
        #expect(scope?.sources == nil)
    }
}

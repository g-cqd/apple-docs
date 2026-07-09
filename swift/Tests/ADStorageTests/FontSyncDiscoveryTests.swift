// FontSync discovery + pkg-extraction plumbing gates: the recursive `discover`
// (the JS `discoverAppleFontFiles` walks — extracted DMG fonts live in
// `extracted/<family>/`, so a one-level scan indexed 0 remote fonts) and the
// `sanitizeFileName` port the pkg-expansion scratch layout uses. Pure
// filesystem fixtures — no DB, no hdiutil, no network; the end-to-end DMG →
// pkg → fonts path is exercised by the functional `--download-fonts` check.

import Foundation
import Testing

@testable import ADStorage

@Suite("FontSync discovery")
struct FontSyncDiscoveryTests {
    /// Builds a throwaway tree, returns its root. Caller removes it.
    private func makeTree(_ files: [String]) throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("fontsync-discover-\(UUID().uuidString)")
        for file in files {
            let full = root.appendingPathComponent(file)
            try FileManager.default.createDirectory(
                at: full.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("stub".utf8).write(to: full)
        }
        return root
    }

    @Test("discover recurses into per-family subdirectories and skips __MACOSX")
    func discoverRecursesSubdirectories() throws {
        let root = try makeTree([
            "sf-mono/SF-Mono-Bold.otf",
            "sf-mono/nested/SF-Mono-Regular.otf",
            "sf-pro/SF-Pro.ttf",
            "sf-pro/readme.txt",
            "__MACOSX/SF-Mono-Ghost.otf",
            "Loose.ttc"
        ])
        defer { try? FileManager.default.removeItem(at: root) }
        let found = FontSync.discover([root.path])
        let names = Set(found.map(\.fileName))
        #expect(names == ["SF-Mono-Bold.otf", "SF-Mono-Regular.otf", "SF-Pro.ttf", "Loose.ttc"])
        #expect(found.allSatisfy { $0.filePath.hasPrefix(root.path) })
    }

    @Test("discover dedups by absolute path across overlapping roots and skips missing dirs")
    func discoverDedupsAcrossRoots() throws {
        let root = try makeTree(["sf-mono/SF-Mono-Bold.otf"])
        defer { try? FileManager.default.removeItem(at: root) }
        let overlapping = [root.path, root.appendingPathComponent("sf-mono").path, "/nonexistent-dir-xyz"]
        let found = FontSync.discover(overlapping)
        #expect(found.count == 1)
        #expect(found.first?.fileName == "SF-Mono-Bold.otf")
    }

    @Test("discover is deterministic across runs")
    func discoverDeterministicOrder() throws {
        let root = try makeTree([
            "b/B2.otf", "b/B1.otf", "a/A.ttf", "Z.ttf"
        ])
        defer { try? FileManager.default.removeItem(at: root) }
        let first = FontSync.discover([root.path])
        let second = FontSync.discover([root.path])
        #expect(first == second)
        // Depth-first with per-level sorted entries ("Z" < "a" in the ASCII sort).
        #expect(first.map(\.fileName) == ["Z.ttf", "A.ttf", "B1.otf", "B2.otf"])
    }

    @Test(
        "sanitizeFileName mirrors the JS regex pair",
        arguments: [
            ("SF Mono Fonts.pkg", "SF-Mono-Fonts.pkg"),
            ("SF-Pro.pkg", "SF-Pro.pkg"),
            ("weird//name?.pkg", "weird-name-.pkg"),
            ("--dashed--", "dashed"),
            ("!!!", "asset"),
            ("", "asset"),
            ("a!!b", "a-b"),
            ("Café.pkg", "Caf-.pkg")
        ])
    func sanitizeFileNameCases(input: String, expected: String) {
        #expect(FontSync.sanitizeFileName(input) == expected)
    }
}

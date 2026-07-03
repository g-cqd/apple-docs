import Foundation
import Testing

@testable import ADOps

// Exercises the render-all pipeline end-to-end (ops/cmd/render-all.js): template
// discovery, output-name mapping, write/check/dry-run modes over an in-memory
// filesystem, and the real POSIX atomic O_EXCL write.

private let opsDir = "/ops"

/// The 11 committed templates in their real ops subdirectories.
private let templateLayout: [(basename: String, subdir: String)] = [
    ("Caddyfile.tpl", "caddy"),
    ("config.yml.tpl", "cloudflared"),
    ("config-mcp.yml.tpl", "cloudflared"),
    ("apple-docs.proxy.plist.tpl", "launchd"),
    ("apple-docs.web.plist.tpl", "launchd"),
    ("apple-docs.mcp.plist.tpl", "launchd"),
    ("apple-docs.watchdog.plist.tpl", "launchd"),
    ("apple-docs.autoroll.plist.tpl", "launchd"),
    ("cloudflared.apple-docs.plist.tpl", "launchd"),
    ("cloudflared.apple-docs-mcp.plist.tpl", "launchd"),
    ("sudoers.apple-docs-launchctl.tpl", "launchd")
]

private func fixtureEnv() throws -> LoadedEnv {
    var vars = OpsEnv.parse(Fixtures.text("fixture.env"))
    try OpsEnv.applyDerived(&vars)
    return OpsEnv.finalize(vars: vars, opsDir: opsDir)
}

private func seededFileSystem() -> MemoryFileSystem {
    let fs = MemoryFileSystem()
    for entry in templateLayout {
        let path = "\(opsDir)/\(entry.subdir)/\(entry.basename)"
        fs.seed(file: path, Fixtures.bytes("templates/\(entry.basename)"))
    }
    return fs
}

@Test func renderAllWritesEveryTemplateToMappedPath() throws {
    let env = try fixtureEnv()
    let fs = seededFileSystem()
    let outcome = RenderAll.run(env: env, mode: .write, fs: fs, logger: CapturingLogger())

    #expect(outcome.templateCount == 11)
    #expect(outcome.renderedCount == 11)
    #expect(outcome.exitCode == 0)

    let snapshot = fs.snapshot()
    for entry in outcome.entries {
        let expectedBytes = Fixtures.bytes("expected/\(lastPathComponent(entry.outputPath))")
        #expect(
            snapshot[entry.outputPath] == expectedBytes,
            "rendered bytes mismatch at \(entry.outputPath)")
    }
    // The web/mcp plists carry the allowlisted-but-empty APPLE_DOCS_NATIVE.
    let webEntry = outcome.entries.first { $0.outputPath.hasSuffix(".web.plist") }
    #expect(webEntry?.unresolved == ["APPLE_DOCS_NATIVE"])
}

@Test func renderAllFindsTemplatesSorted() throws {
    let env = try fixtureEnv()
    let templates = RenderAll.findTemplates(root: env.opsDir, fs: seededFileSystem())
    #expect(templates.count == 11)
    #expect(templates == templates.sorted { lexicographicallyLess(Array($0.utf8), Array($1.utf8)) })
}

@Test func checkModeReportsNoDriftAfterWrite() throws {
    let env = try fixtureEnv()
    let fs = seededFileSystem()
    _ = RenderAll.run(env: env, mode: .write, fs: fs, logger: CapturingLogger())
    let outcome = RenderAll.run(env: env, mode: .check, fs: fs, logger: CapturingLogger())
    #expect(outcome.driftCount == 0)
    #expect(outcome.exitCode == 0)
}

@Test func checkModeDetectsDrift() throws {
    let env = try fixtureEnv()
    let fs = seededFileSystem()
    _ = RenderAll.run(env: env, mode: .write, fs: fs, logger: CapturingLogger())
    // Corrupt one rendered output.
    fs.seed(file: "\(opsDir)/caddy/Caddyfile", Array("tampered".utf8))
    let outcome = RenderAll.run(env: env, mode: .check, fs: fs, logger: CapturingLogger())
    #expect(outcome.driftCount == 1)
    #expect(outcome.exitCode == 1)
}

@Test func dryRunWritesNothing() throws {
    let env = try fixtureEnv()
    let fs = seededFileSystem()
    let outcome = RenderAll.run(env: env, mode: .dryRun, fs: fs, logger: CapturingLogger())
    #expect(outcome.renderedCount == 0)
    #expect(outcome.exitCode == 0)
    // Only the 11 seeded templates remain — no rendered outputs.
    #expect(fs.snapshot().count == 11)
}

// MARK: - the real POSIX atomic write

@Test func posixAtomicWriteRoundTripsBytesAndMode() throws {
    let dir = NSTemporaryDirectory() + "adops-atomic-\(UUID().uuidString)"
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let fs = PosixFileSystem()
    let target = dir + "/nested/out.txt"
    let payload = Array("hello ✓ world".utf8)
    try fs.writeAtomic(target, payload, mode: 0o644)

    #expect(fs.tryRead(target) == payload)
    let perms =
        try FileManager.default.attributesOfItem(atPath: target)[.posixPermissions]
        as? NSNumber
    #expect(perms?.uint16Value == 0o644)
}

@Test func posixAtomicWriteReplacesExistingFile() throws {
    let dir = NSTemporaryDirectory() + "adops-atomic-\(UUID().uuidString)"
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let fs = PosixFileSystem()
    let target = dir + "/out.txt"
    try fs.writeAtomic(target, Array("first".utf8))
    try fs.writeAtomic(target, Array("second".utf8))
    #expect(fs.tryReadText(target) == "second")
}

@Test func posixAtomicWriteReplacesSymlinkWithoutFollowingIt() throws {
    let dir = NSTemporaryDirectory() + "adops-atomic-\(UUID().uuidString)"
    defer { try? FileManager.default.removeItem(atPath: dir) }
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let outside = dir + "/outside.txt"
    try "SENSITIVE".write(toFile: outside, atomically: true, encoding: .utf8)
    let target = dir + "/link"
    try FileManager.default.createSymbolicLink(atPath: target, withDestinationPath: outside)

    let fs = PosixFileSystem()
    try fs.writeAtomic(target, Array("rendered".utf8))

    // The symlink was replaced by a regular file (rename over it); the file it
    // pointed at is untouched — the anti-symlink guard held.
    #expect(fs.tryReadText(target) == "rendered")
    #expect(try String(contentsOfFile: outside, encoding: .utf8) == "SENSITIVE")
    let attrs = try FileManager.default.attributesOfItem(atPath: target)
    #expect((attrs[.type] as? FileAttributeType) == .typeRegular)
}

import AppleDocsTestSupport
import Testing

@Suite("Banned APIs")
struct BannedAPITests {
    @Test func `detects banned needle with file and line number`() {
        let rule = BannedAPIs.Rule(name: "Legacy", needles: ["OldCall"], reason: "use NewCall")
        let findings = BannedAPIs.problems(in: [("Sample.swift", "let x = 1\nOldCall()\n")], rules: [rule])
        #expect(findings == ["Sample.swift:2: OldCall (Legacy: use NewCall)"])
    }

    @Test func `no file in Sources or Tests uses Grand Central Dispatch`() {
        let files = RepositoryFiles.swiftFiles(in: ["Sources", "Tests"])
            .filter { $0.name != "BannedAPIs.swift" && $0.name != "BannedAPITests.swift" }
            .map { ($0.path, $0.text) }
        #expect(!files.isEmpty)
        let findings = BannedAPIs.problems(in: files, rules: BannedAPIs.universalRules)
        #expect(findings.isEmpty, "\(findings.joined(separator: "\n"))")
    }

    @Test func `no test file uses wall-clock sleep primitives`() {
        let files = RepositoryFiles.swiftFiles(in: ["Tests"])
            .filter { $0.name != "BannedAPIs.swift" && $0.name != "BannedAPITests.swift" }
            .map { ($0.path, $0.text) }
        let findings = BannedAPIs.problems(in: files, rules: BannedAPIs.testOnlyRules)
        #expect(findings.isEmpty, "\(findings.joined(separator: "\n"))")
    }

    @Test func `cross-platform targets never import macOS-only frameworks`() {
        let files = RepositoryFiles.swiftFiles(in: ["Sources"])
            .filter { !$0.path.hasPrefix("Sources/AppleDocsSetupDarwin/") }
            .map { ($0.path, $0.text) }
        let findings = BannedAPIs.problems(in: files, rules: BannedAPIs.crossPlatformDarwinRules)
        #expect(findings.isEmpty, "\(findings.joined(separator: "\n"))")
    }
}

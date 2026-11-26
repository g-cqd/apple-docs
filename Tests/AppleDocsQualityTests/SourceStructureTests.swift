import AppleDocsTestSupport
import Testing

@Suite("Source structure")
struct SourceStructureTests {
    private func file(_ name: String, _ text: String) -> [(name: String, text: String)] {
        [(name, text)]
    }

    @Test func `one visible type with private helpers in the same file is allowed`() {
        let source = """
            public struct DocumentKey {}
            private struct KeyValidator {}
            fileprivate enum KeyHelper {}
            """
        #expect(SourceStructure.problems(in: file("DocumentKey.swift", source)).isEmpty)
    }

    @Test func `extension-only file for one type is allowed`() {
        let source = "extension DocumentKey: Sendable {}\n"
        #expect(SourceStructure.problems(in: file("DocumentKey+Sendable.swift", source)).isEmpty)
    }

    @Test func `two visible top-level types in one file are rejected`() {
        let source = "struct Alpha {}\nenum Beta {}\n"
        let problems = SourceStructure.problems(in: file("Alpha.swift", source))
        #expect(problems.count == 1)
        #expect(problems.first?.contains("2 visible top-level types") == true)
    }

    @Test func `mismatched filename for primary type is rejected`() {
        let problems = SourceStructure.problems(in: file("Wrong.swift", "public struct Right {}\n"))
        #expect(problems.count == 1)
    }

    @Test func `file exceeding 250 lines is rejected`() {
        let atLimit = "struct Exact {}\n" + String(repeating: "// x\n", count: SourceStructure.maximumLines - 1)
        #expect(SourceStructure.problems(in: file("Exact.swift", atLimit)).isEmpty)
        #expect(SourceStructure.problems(in: file("Exact.swift", atLimit + "// x\n")).count == 1)
    }

    @Test func `every Swift file in Sources and Tests conforms to structure rules`() {
        let files = RepositoryFiles.swiftFiles(in: ["Sources", "Tests"])
        #expect(!files.isEmpty, "repository scan must discover Swift files")
        let problems = SourceStructure.problems(in: files.map { ($0.name, $0.text) })
        #expect(problems.isEmpty, "\(problems.joined(separator: "\n"))")
    }
}

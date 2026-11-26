import AppleDocsContent
import AppleDocsCore
import AppleDocsPipeline
import AppleDocsSetup
import AppleDocsSources
import AppleDocsStorage
import Foundation
import Testing

@Suite("Pipeline, Markdown Converter & SnapshotInstaller")
struct PipelineAndInstallerTests {
    @Test func `converts Markdown with YAML front-matter via AemiMarkdown and ingests through SyncPipeline`() throws {
        let markdown = """
            ---
            title: Swift Concurrency Guide
            ---

            Structured concurrency guarantees clear task lifetimes.

            ## Actors

            Actors protect mutable state from data races.
            """
        let key = try DocumentKey("swift-book/concurrency")
        let converted = MarkdownDocumentConverter.convert(
            markdown: Array(markdown.utf8),
            key: key,
            sourceType: .swiftBook,
            fallbackTitle: "Fallback"
        )
        #expect(converted.document.title == "Swift Concurrency Guide")
        #expect(converted.sections.count == 2)
        #expect(converted.sections[1].heading == "Actors")

        let store = try CorpusStore(path: ":memory:")
        let root = CorpusRootRecord(
            slug: "swift-book",
            displayName: "The Swift Programming Language",
            kind: "book",
            sourceType: .swiftBook
        )
        let report = try SyncPipeline.ingest(
            payloads: [
                SourcePayload(
                    key: key,
                    sourceType: .swiftBook,
                    fallbackTitle: "Fallback",
                    encoding: .markdown,
                    body: Array(markdown.utf8)
                )
            ],
            root: root,
            into: store
        )
        #expect(report.documentsIngested == 1)
        #expect(report.sectionsIngested == 2)
        #expect(report.failures == 0)
        #expect(try store.document(forKey: key)?.title == "Swift Concurrency Guide")
    }

    @Test func `SnapshotInstaller verifies SHA-256, checks archive safety, and atomically installs tar.gz`()
        async throws
    {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-docs-inst-\(UUID().uuidString)")
        let srcDir = tempDir.appendingPathComponent("src", isDirectory: true)
        let dstDir = tempDir.appendingPathComponent("dst", isDirectory: true)
        try FileManager.default.createDirectory(at: srcDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let manifestData = Data("{\"version\":1}\n".utf8)
        try manifestData.write(to: srcDir.appendingPathComponent("manifest.json"))

        let archiveURL = tempDir.appendingPathComponent("snapshot.tar.gz")
        let tarResult = try await ScrubbedSubprocess.run(
            executable: "tar",
            arguments: ["-czf", archiveURL.path, "-C", srcDir.path, "manifest.json"]
        )
        #expect(tarResult.exitCode == 0)

        let digest = try SnapshotVerifier.sha256Hex(fileAtPath: archiveURL.path)
        try await SnapshotInstaller.installLocalArchive(
            archivePath: archiveURL.path,
            expectedSHA256Text: "\(digest)  snapshot.tar.gz\n",
            into: dstDir.path
        )

        let installed = try String(contentsOf: dstDir.appendingPathComponent("manifest.json"), encoding: .utf8)
        #expect(installed == "{\"version\":1}\n")
    }
}

import AppleDocsMCP
import AppleDocsStorage
import Foundation
import Testing

@Suite("MCP stdio transport")
struct MCPStdioTransportTests {
    @Test(.timeLimit(.minutes(1)))
    func `answers each request while stdin stays open (interactive clients)`() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("apple-docs-stdio-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let dbPath = dir.appendingPathComponent("corpus.db").path
        try CorpusStore(path: dbPath, options: .readWrite).close()
        let dispatcher = MCPServerDispatcher(databasePath: dbPath)

        let input = Pipe()
        let output = Pipe()
        let server = Task {
            try await MCPStdioTransport.run(
                dispatcher: dispatcher,
                input: input.fileHandleForReading,
                output: output.fileHandleForWriting
            )
        }
        input.fileHandleForWriting.write(Data(#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#.utf8 + [0x0A]))

        // The reply must arrive while stdin is still open.
        let reply = await Task.detached { output.fileHandleForReading.availableData }.value
        #expect(String(decoding: reply, as: UTF8.self).contains(#""id":7"#))

        try input.fileHandleForWriting.close()
        try await server.value
        await dispatcher.close()
    }
}

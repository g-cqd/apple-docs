import AppleDocsCommands
import AppleDocsContent
import AppleDocsCore
import AppleDocsMCP
import AppleDocsSearch
import AppleDocsStorage
import AppleDocsWeb
import Benchmark
import Foundation

nonisolated(unsafe) let benchmarks: @Sendable () -> Void = {
    Benchmark.defaultConfiguration = .init(
        metrics: [.wallClock, .cpuTotal, .instructions, .mallocCountTotal, .peakMemoryResident],
        timeUnits: .microseconds,
        warmupIterations: 3,
        scalingFactor: .one,
        maxDuration: .seconds(3),
        maxIterations: 10_000,
        thresholds: [
            .instructions: .init(relative: [.p50: 5.0, .p90: 10.0]),
            .mallocCountTotal: .init(relative: [.p50: 5.0, .p90: 10.0])
        ]
    )

    let databasePath = BenchmarkFixture.databasePath
    // Measure the uncached tool path (the MCP result cache would turn repeated calls into lookups).
    setenv("APPLE_DOCS_MCP_CACHE", "off", 1)
    let queries = ["navigation stack", "ViewModel", "layout grid", "binding", "scroll animation"]

    Benchmark("search: lexical query over 20k documents") { benchmark in
        let store = try CorpusStore(path: databasePath, options: .readOnly)
        defer { store.close() }
        for index in benchmark.scaledIterations {
            let request = CorpusSearchRequest(query: queries[index % queries.count], limit: 25)
            blackHole(try CorpusQueryService.search(request, on: store.connection))
        }
    }

    Benchmark("read_doc: MCP dispatch with Bun-shaped rendering") { benchmark in
        let dispatcher = MCPServerDispatcher(databasePath: databasePath)
        let payloads = (0 ..< 64)
            .map { index in
                Array(
                    #"{"jsonrpc":"2.0","id":\#(index),"method":"tools/call","params":{"name":"read_doc","arguments":{"path":"\#(BenchmarkFixture.key(index * 31))"}}}"#
                        .utf8
                )
            }
        for index in benchmark.scaledIterations {
            blackHole(await dispatcher.handleRawPayload(payloads[index % payloads.count]))
        }
        await dispatcher.close()
    }

    Benchmark("read_doc: paginated (maxChars 1000, page 2)") { benchmark in
        let dispatcher = MCPServerDispatcher(databasePath: databasePath)
        let payload = Array(
            #"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_doc","arguments":{"path":"\#(BenchmarkFixture.key(42))","maxChars":1000,"page":2}}}"#
                .utf8
        )
        for _ in benchmark.scaledIterations {
            blackHole(await dispatcher.handleRawPayload(payload))
        }
        await dispatcher.close()
    }

    Benchmark("web: render a document page") { benchmark in
        let store = try CorpusStore(path: databasePath, options: .readOnly)
        defer { store.close() }
        let key = try DocumentKey(BenchmarkFixture.key(7))
        for _ in benchmark.scaledIterations {
            guard let view = try WebDocumentView.load(key: key, store: store) else { continue }
            blackHole(WebHTMLRenderer.renderDocumentPage(view))
        }
    }

    let doccInputs: [(key: DocumentKey, bytes: [UInt8])] = DocCInputs.load()
    Benchmark("content: DocC JSON normalization (golden inputs)") { benchmark in
        for index in benchmark.scaledIterations {
            let input = doccInputs[index % doccInputs.count]
            blackHole(try DocCJSONConverter.convert(json: input.bytes, key: input.key))
        }
    }
}

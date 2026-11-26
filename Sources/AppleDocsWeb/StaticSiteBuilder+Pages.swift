import AppleDocsCore
import AppleDocsStorage

extension StaticSiteBuilder {
    /// Renders `keys` to `doc/<key>/index.html` with `concurrency` workers, each owning one read-only store
    /// and a strided share of the keys; per-page failures are counted, not fatal.
    static func exportPages(
        _ keys: [String],
        roots: [CorpusRootRecord],
        databasePath: String,
        output: StaticSiteOutput,
        concurrency: Int
    ) async throws -> (exported: [String], failures: Int) {
        let workers = max(1, min(concurrency, keys.count))
        return try await withThrowingTaskGroup(of: (exported: [String], failures: Int).self) { group in
            for worker in 0 ..< workers {
                group.addTask {
                    try exportSlice(
                        keys,
                        worker: worker,
                        stride: workers,
                        roots: roots,
                        databasePath: databasePath,
                        output: output
                    )
                }
            }
            var exported: [String] = []
            exported.reserveCapacity(keys.count)
            var failures = 0
            for try await result in group {
                exported += result.exported
                failures += result.failures
            }
            return (exported.sorted(), failures)
        }
    }

    private static func exportSlice(
        _ keys: [String],
        worker: Int,
        stride step: Int,
        roots: [CorpusRootRecord],
        databasePath: String,
        output: StaticSiteOutput
    ) throws -> (exported: [String], failures: Int) {
        let store: CorpusStore
        do { store = try CorpusStore(path: databasePath, options: .readOnly) } catch {
            throw BuildError.database("\(error)")
        }
        defer { store.close() }
        var exported: [String] = []
        var failures = 0
        for index in Swift.stride(from: worker, to: keys.count, by: step) {
            do {
                let key = try DocumentKey(keys[index])
                guard let view = try WebDocumentView.load(key: key, store: store, roots: roots) else {
                    failures += 1
                    continue
                }
                try output.writeHTML(
                    WebHTMLRenderer.renderDocumentPage(view),
                    to: "doc/\(WebDocPath.safeKey(key.rawValue))/index.html"
                )
                exported.append(key.rawValue)
            } catch {
                failures += 1
            }
        }
        return (exported, failures)
    }
}

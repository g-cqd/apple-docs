import Foundation

/// Resolves the active `APPLE_DOCS_HOME` data directory and corpus database path.
public enum CorpusPaths: Sendable {
    /// Default corpus data directory (`APPLE_DOCS_HOME` env override, else `~/.apple-docs`).
    public static func defaultDataDirectory(environment: [String: String]? = nil) -> String {
        let env = environment ?? ProcessInfo.processInfo.environment
        if let override = env["APPLE_DOCS_HOME"], !override.isEmpty {
            return override
        }
        return URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".apple-docs", isDirectory: true)
            .path
    }

    /// Default path to the Swift v1 SQLite database inside `dataDirectory`.
    public static func defaultDatabasePath(dataDirectory: String = defaultDataDirectory()) -> String {
        URL(fileURLWithPath: dataDirectory, isDirectory: true)
            .appendingPathComponent("apple-docs-v1.db")
            .path
    }
}

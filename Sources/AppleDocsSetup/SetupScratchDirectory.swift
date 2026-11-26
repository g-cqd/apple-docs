public import Foundation

/// Creates isolated temporary scratch directories with automatic cleanup on exit or error.
///
/// Shared by `SnapshotBuilder`, `SnapshotInstaller`, and `SVGRasterizer` so staging directory
/// lifecycle is defined once and never leaks temp directories.
public enum SetupScratchDirectory: Sendable {
    /// Creates a unique directory inside `parent` (or `FileManager.default.temporaryDirectory`),
    /// invokes `body`, and always deletes the directory afterward.
    public static func withDirectory<T>(
        prefix: String,
        under parent: URL? = nil,
        _ body: (URL) async throws(SetupError) -> T
    ) async throws(SetupError) -> T {
        let fm = FileManager.default
        let base = parent ?? fm.temporaryDirectory
        let dir = base.appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            throw .ioFailure("Unable to create scratch directory under \(base.path): \(error)")
        }
        defer { try? fm.removeItem(at: dir) }
        return try await body(dir)
    }
}

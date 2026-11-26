public import Foundation

/// Scans repository directories for Swift source files relative to the package root.
public enum RepositoryFiles: Sendable {
    /// Absolute path to the repository root derived from `#filePath`.
    public static var packageRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    /// Reads all `.swift` files under the given relative directories, sorted by relative path.
    public static func swiftFiles(in directories: [String]) -> [(name: String, path: String, text: String)] {
        let root = packageRoot
        let manager = FileManager.default
        var results: [(name: String, path: String, text: String)] = []

        for directory in directories {
            let base = root.appendingPathComponent(directory)
            guard let enumerator = manager.enumerator(at: base, includingPropertiesForKeys: nil) else {
                continue
            }
            while let entry = enumerator.nextObject() as? URL {
                guard entry.pathExtension == "swift" else { continue }
                guard let text = try? String(contentsOf: entry, encoding: .utf8) else { continue }
                let relative = entry.path.replacingOccurrences(of: root.path + "/", with: "")
                results.append((name: entry.lastPathComponent, path: relative, text: text))
            }
        }
        return results.sorted { $0.path < $1.path }
    }
}

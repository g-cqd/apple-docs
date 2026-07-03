import Foundation
import Testing

@testable import ADOps

/// Access to the bundled `Fixtures/` resource tree (templates + JS-rendered
/// expected outputs + the canonical `.env`).
enum Fixtures {
    static let base: URL = {
        guard let url = Bundle.module.url(forResource: "Fixtures", withExtension: nil) else {
            fatalError("ADOpsTests: Fixtures/ resource directory not bundled")
        }
        return url
    }()

    static func bytes(_ relative: String) -> [UInt8] {
        let url = base.appendingPathComponent(relative)
        guard let data = try? Data(contentsOf: url) else {
            fatalError("ADOpsTests: missing fixture \(relative)")
        }
        return [UInt8](data)
    }

    static func text(_ relative: String) -> String {
        String(decoding: bytes(relative), as: UTF8.self)
    }
}

/// A test-only logger that captures every emitted line in order.
final class CapturingLogger: OpsLogging, @unchecked Sendable {
    private let lock = NSLock()
    private var _lines: [String] = []
    let logPath: String? = nil

    var lines: [String] {
        lock.lock()
        defer { lock.unlock() }
        return _lines
    }

    private func append(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        _lines.append(line)
    }

    func say(_ message: String) { append(message) }
    func warn(_ message: String) { append("WARN: " + message) }
    func error(_ message: String) { append("ERROR: " + message) }
    func runStart(_ command: String, _ arguments: [String]) {
        append("$ " + ([command] + arguments).joined(separator: " "))
    }
    func runOutput(_ text: String) { append(text) }
}

/// An in-memory filesystem for exercising RenderAll without touching disk.
final class MemoryFileSystem: OpsFileSystem, @unchecked Sendable {
    private let lock = NSLock()
    private var files: [String: [UInt8]] = [:]
    private var dirs: Set<String> = []

    init(files: [String: [UInt8]] = [:], dirs: Set<String> = []) {
        self.files = files
        self.dirs = dirs
    }

    func seed(file path: String, _ bytes: [UInt8]) {
        lock.lock()
        defer { lock.unlock() }
        files[path] = bytes
        var parent = parentPath(path)
        while !parent.isEmpty {
            dirs.insert(parent)
            parent = parentPath(parent)
        }
    }

    func snapshot() -> [String: [UInt8]] {
        lock.lock()
        defer { lock.unlock() }
        return files
    }

    func read(_ path: String) throws -> [UInt8] {
        lock.lock()
        defer { lock.unlock() }
        guard let bytes = files[path] else { throw OpsIOError("no such file \(path)") }
        return bytes
    }

    func tryRead(_ path: String) -> [UInt8]? {
        lock.lock()
        defer { lock.unlock() }
        return files[path]
    }

    func exists(_ path: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return files[path] != nil || dirs.contains(path)
    }

    func listDir(_ path: String) throws -> [DirEntry] {
        lock.lock()
        defer { lock.unlock() }
        var entries: [DirEntry] = []
        var seen: Set<String> = []
        let prefix = path.hasSuffix("/") ? path : path + "/"
        for key in files.keys where key.hasPrefix(prefix) {
            let rest = String(key.dropFirst(prefix.count))
            if let slash = rest.firstIndex(of: "/") {
                let dir = String(rest[rest.startIndex ..< slash])
                if seen.insert(dir).inserted {
                    entries.append(DirEntry(name: dir, isDirectory: true, isFile: false))
                }
            } else if seen.insert(rest).inserted {
                entries.append(DirEntry(name: rest, isDirectory: false, isFile: true))
            }
        }
        for dir in dirs where dir.hasPrefix(prefix) {
            let rest = String(dir.dropFirst(prefix.count))
            if !rest.contains("/"), seen.insert(rest).inserted {
                entries.append(DirEntry(name: rest, isDirectory: true, isFile: false))
            }
        }
        return entries
    }

    func ensureDir(_ path: String) throws {
        lock.lock()
        defer { lock.unlock() }
        dirs.insert(path)
    }

    func writeAtomic(_ path: String, _ bytes: [UInt8], mode: UInt16) throws {
        lock.lock()
        defer { lock.unlock() }
        files[path] = bytes
        dirs.insert(parentPath(path))
    }
}

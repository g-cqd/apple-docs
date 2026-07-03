// Filesystem seam for the ops layer. The atomic O_EXCL write (staging file with
// O_CREAT|O_EXCL, then rename over the target) is the native port of
// ops/lib/render-template.js's `defaultWrite` / render-all.js's `fs.write`: a
// hostile symlink at the destination can't redirect the write, and the rename is
// atomic (same directory, same filesystem — the POSIX guarantee). Injectable so
// the verbs unit-test without touching real disk.

private import Foundation

/// One directory entry from `listDir`.
public struct DirEntry: Sendable, Equatable {
    public let name: String
    public let isDirectory: Bool
    public let isFile: Bool
    public init(name: String, isDirectory: Bool, isFile: Bool) {
        self.name = name
        self.isDirectory = isDirectory
        self.isFile = isFile
    }
}

/// Errors surfaced by the POSIX filesystem operations.
public struct OpsIOError: Error, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

/// The filesystem operations the ops verbs need, all injectable.
public protocol OpsFileSystem: Sendable {
    func read(_ path: String) throws -> [UInt8]
    func tryRead(_ path: String) -> [UInt8]?
    func exists(_ path: String) -> Bool
    func listDir(_ path: String) throws -> [DirEntry]
    func ensureDir(_ path: String) throws
    /// Atomic create-exclusive-staging + rename. `mode` is the final file mode.
    func writeAtomic(_ path: String, _ bytes: [UInt8], mode: UInt16) throws
}

extension OpsFileSystem {
    /// Read a file as UTF-8 text, or `nil` when it is absent/unreadable.
    public func tryReadText(_ path: String) -> String? {
        tryRead(path).map { String(decoding: $0, as: UTF8.self) }
    }
    public func writeAtomic(_ path: String, _ bytes: [UInt8]) throws {
        try writeAtomic(path, bytes, mode: 0o644)
    }
}

/// The production filesystem: real disk via POSIX.
public struct PosixFileSystem: OpsFileSystem {
    /// A `@Sendable` epoch-millis clock used only to name the staging file.
    private let nowMs: @Sendable () -> Int64

    /// The default staging-name clock (body uses Foundation; the type does not,
    /// so it is usable as a public default argument under `InternalImportsByDefault`).
    public static let systemClockMs: @Sendable () -> Int64 = {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    public init(nowMs: @escaping @Sendable () -> Int64 = PosixFileSystem.systemClockMs) {
        self.nowMs = nowMs
    }

    public func read(_ path: String) throws -> [UInt8] {
        guard let data = FileManager.default.contents(atPath: path) else {
            throw OpsIOError("cannot read \(path)")
        }
        return [UInt8](data)
    }

    public func tryRead(_ path: String) -> [UInt8]? {
        FileManager.default.contents(atPath: path).map { [UInt8]($0) }
    }

    public func exists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: path)
    }

    public func listDir(_ path: String) throws -> [DirEntry] {
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: path)
        } catch {
            throw OpsIOError("cannot list \(path): \(error)")
        }
        return names.map { name in
            var isDir: ObjCBool = false
            let full = joinPath(path, name)
            let present = FileManager.default.fileExists(atPath: full, isDirectory: &isDir)
            return DirEntry(
                name: name, isDirectory: present && isDir.boolValue,
                isFile: present && !isDir.boolValue)
        }
    }

    public func ensureDir(_ path: String) throws {
        if exists(path) { return }
        do {
            try FileManager.default.createDirectory(
                atPath: path, withIntermediateDirectories: true)
        } catch {
            throw OpsIOError("cannot create directory \(path): \(error)")
        }
    }

    public func writeAtomic(_ path: String, _ bytes: [UInt8], mode: UInt16) throws {
        let dir = (path as NSString).deletingLastPathComponent
        let base = (path as NSString).lastPathComponent
        try ensureDir(dir.isEmpty ? "." : dir)
        let staging = joinPath(
            dir.isEmpty ? "." : dir, ".\(base).\(getpid()).\(nowMs()).tmp")

        // O_CREAT|O_EXCL|O_WRONLY: a pre-existing staging path (or a symlink at
        // it) makes open() fail rather than following it — the anti-symlink guard.
        let fd = staging.withCString { open($0, O_CREAT | O_EXCL | O_WRONLY, mode_t(mode)) }
        if fd < 0 {
            throw OpsIOError("cannot create staging file \(staging) (errno \(errno))")
        }
        var wroteOK = true
        var writeErrno: Int32 = 0
        bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = write(fd, raw.baseAddress?.advanced(by: offset), raw.count - offset)
                if n <= 0 {
                    wroteOK = false
                    writeErrno = errno
                    break
                }
                offset += n
            }
        }
        close(fd)
        guard wroteOK else {
            unlink(staging)
            throw OpsIOError("write failed for \(staging) (errno \(writeErrno))")
        }
        // rename(2): atomic replace of the target within the same directory.
        let renamed = staging.withCString { s in path.withCString { p in rename(s, p) } }
        if renamed != 0 {
            let renameErrno = errno
            unlink(staging)
            throw OpsIOError("rename \(staging) -> \(path) failed (errno \(renameErrno))")
        }
    }
}

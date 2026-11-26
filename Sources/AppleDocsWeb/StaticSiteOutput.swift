import Foundation

#if canImport(Darwin)
    import Darwin
#elseif canImport(Glibc)
    import Glibc
#endif

/// A private staging directory next to the final output that becomes the output in one rename.
///
/// Files are written into `.<name>.staging-<uuid>` (nothing reads the staging tree), then ``commit()``
/// publishes it: on Darwin by exchanging the two directories in one `renamex_np(RENAME_SWAP)` call, so
/// readers of `outputDirectory` see either the complete old site or the complete new one; elsewhere by
/// renaming the previous export aside and staging into place (a brief window where the path is absent).
/// The old tree is deleted only after the new one is in place. A non-empty `outputDirectory` without the
/// export marker is never replaced.
struct StaticSiteOutput: Sendable {
    let final: URL
    let staging: URL

    init(outputDirectory: String, markerFileName: String) throws(StaticSiteBuilder.BuildError) {
        let final = URL(fileURLWithPath: outputDirectory, isDirectory: true).standardizedFileURL
        let fm = FileManager.default
        guard final.path != "/", final.path != fm.homeDirectoryForCurrentUser.standardizedFileURL.path else {
            throw .unsafeOutputDirectory(final.path)
        }
        var isDirectory: ObjCBool = false
        if fm.fileExists(atPath: final.path, isDirectory: &isDirectory) {
            let contents = (try? fm.contentsOfDirectory(atPath: final.path)) ?? []
            guard isDirectory.boolValue, contents.isEmpty || contents.contains(markerFileName) else {
                throw .unsafeOutputDirectory(final.path)
            }
        }
        let parent = final.deletingLastPathComponent()
        let staging = parent.appendingPathComponent(".\(final.lastPathComponent).staging-\(UUID().uuidString)")
        do {
            try fm.createDirectory(at: staging, withIntermediateDirectories: true)
        } catch {
            throw .io("cannot create staging directory: \(error.localizedDescription)")
        }
        self.final = final
        self.staging = staging
    }

    /// Writes `bytes` at `relativePath` (validated: no absolute paths, no `.`/`..` segments) inside staging.
    func write(_ bytes: some Sequence<UInt8>, to relativePath: String) throws(StaticSiteBuilder.BuildError) {
        let segments = relativePath.split(separator: "/", omittingEmptySubsequences: false)
        guard !relativePath.hasPrefix("/"), !segments.isEmpty,
            segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\0") })
        else { throw .unsafePath(relativePath) }
        let url = staging.appendingPathComponent(relativePath)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try Data(bytes).write(to: url)
        } catch {
            throw .io("\(relativePath): \(error.localizedDescription)")
        }
    }

    /// Swaps staging into place; the previous export (if any) is removed only after the swap succeeded.
    func commit() throws(StaticSiteBuilder.BuildError) {
        let fm = FileManager.default
        let parent = final.deletingLastPathComponent()
        defer { Self.syncDirectory(parent) }
        guard fm.fileExists(atPath: final.path) else {
            do { try fm.moveItem(at: staging, to: final) } catch {
                throw .io("cannot publish the export: \(error.localizedDescription)")
            }
            return
        }
        #if canImport(Darwin)
            if renamex_np(staging.path, final.path, UInt32(RENAME_SWAP)) == 0 {
                try? fm.removeItem(at: staging)  // now holds the previous export
                return
            }
        #endif
        let previous = parent.appendingPathComponent(".\(final.lastPathComponent).old-\(UUID().uuidString)")
        do {
            try fm.moveItem(at: final, to: previous)
            do {
                try fm.moveItem(at: staging, to: final)
            } catch {
                try? fm.moveItem(at: previous, to: final)
                throw error
            }
            try? fm.removeItem(at: previous)
        } catch {
            throw .io("cannot publish the export: \(error.localizedDescription)")
        }
    }

    /// Flushes `directory`'s entries (the renames) to stable storage.
    private static func syncDirectory(_ directory: URL) {
        let fd = open(directory.path, O_RDONLY)
        guard fd >= 0 else { return }
        defer { _ = close(fd) }
        _ = fsync(fd)
    }

    /// Removes the staging tree (after a failed build).
    func discard() {
        try? FileManager.default.removeItem(at: staging)
    }
}

// The ad-cli side of the S6 asset pipeline: the `src/web` file reader + the
// `bun build` subprocess seam behind ADWebBuild's `AssetSource`.
//
// `bun build <entry> --target=browser --minify --format=iife` is byte-identical
// to the `Bun.build` API call the JS pipeline makes (verified on all six
// bundles), so shelling the CLI keeps the emitted assets byte-stable against
// the oracle. When no `bun` binary resolves (CI / minimal hosts), the
// `PassthroughBundler` copies each entry file verbatim — the site still works
// in dev terms but is NOT parity-grade; a warning says so.

import ADWebBuild
import ArgumentParser
import Foundation

/// The JS-bundling seam: minify+bundle one browser entrypoint.
protocol JsBundler {
    func bundle(entrypoint: String) throws -> [UInt8]
    /// Human label for the build log ("bun build" / "passthrough").
    var label: String { get }
}

/// Shells `bun build` (the byte-stable subprocess seam, operator decision #3).
struct BunBundler: JsBundler {
    let bunPath: String
    var label: String { "bun build (\(bunPath))" }

    func bundle(entrypoint: String) throws -> [UInt8] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: bunPath)
        process.arguments = ["build", entrypoint, "--target=browser", "--minify", "--format=iife"]
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        // Drain stdout BEFORE waiting: a bundle larger than the pipe buffer
        // would deadlock a wait-first sequence.
        let bytes = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let message = String(decoding: stderr.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            throw ValidationError("bun build failed for \(entrypoint): \(message)")
        }
        return Array(bytes)
    }
}

/// No-bun fallback: the entry file's bytes verbatim (unbundled, unminified).
/// Keeps `web build` usable on hosts without bun, at the cost of asset parity.
struct PassthroughBundler: JsBundler {
    var label: String { "passthrough (bun not found — assets unbundled, NOT parity-grade)" }

    func bundle(entrypoint: String) throws -> [UInt8] {
        guard let data = FileManager.default.contents(atPath: entrypoint) else {
            throw ValidationError("asset entry not found: \(entrypoint)")
        }
        return Array(data)
    }
}

/// `APPLE_DOCS_BUN` override, else the first executable `bun` on PATH, else the
/// passthrough fallback.
func resolveJsBundler() -> any JsBundler {
    let env = ProcessInfo.processInfo.environment
    if let override = env["APPLE_DOCS_BUN"], !override.isEmpty {
        return BunBundler(bunPath: override)
    }
    let fileManager = FileManager.default
    for dir in (env["PATH"] ?? "").split(separator: ":") {
        let candidate = "\(dir)/bun"
        if fileManager.isExecutableFile(atPath: candidate) {
            return BunBundler(bunPath: candidate)
        }
    }
    return PassthroughBundler()
}

/// `AssetSource` over a `src/web` checkout (`--src-web`).
struct FileAssetSource: AssetSource {
    let srcWebDir: String
    let bundler: any JsBundler

    func readAsset(_ relative: String) -> [UInt8]? {
        FileManager.default.contents(atPath: "\(srcWebDir)/assets/\(relative)").map(Array.init)
    }

    func readWorker(_ relative: String) -> [UInt8]? {
        FileManager.default.contents(atPath: "\(srcWebDir)/worker/\(relative)").map(Array.init)
    }

    func bundle(assetEntry relative: String) throws -> [UInt8] {
        try bundler.bundle(entrypoint: "\(srcWebDir)/assets/\(relative)")
    }

    /// Every file under `src/web/public/` (dotfiles included — `.well-known/…`),
    /// relative path preserved; sorted for a deterministic write order. Missing
    /// dir → [] (the JS `existsSync` guard).
    func publicFiles() throws -> [(path: String, bytes: [UInt8])] {
        let root = "\(srcWebDir)/public"
        let fileManager = FileManager.default
        guard let enumerator = fileManager.enumerator(atPath: root) else { return [] }
        var relatives: [String] = []
        for case let relative as String in enumerator {
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: "\(root)/\(relative)", isDirectory: &isDirectory),
                !isDirectory.boolValue
            else { continue }
            relatives.append(relative)
        }
        relatives.sort()
        var out: [(path: String, bytes: [UInt8])] = []
        out.reserveCapacity(relatives.count)
        for relative in relatives {
            guard let data = fileManager.contents(atPath: "\(root)/\(relative)") else {
                throw ValidationError("unreadable public asset: \(root)/\(relative)")
            }
            out.append((path: relative, bytes: Array(data)))
        }
        return out
    }
}

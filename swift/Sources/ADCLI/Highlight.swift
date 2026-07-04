// The ad-cli side of the S5 highlight seam: a synchronous client for the
// `scripts/highlight-server.ts` JSONL coprocess (see that file for the
// protocol + the behavior-identity argument). One request is in flight at a
// time (a lock serializes round-trips), which is exactly the render loop's
// call pattern; responses pair by order, ids are a cross-check.
//
// Degradation: no bun / no script / APPLE_DOCS_NO_HIGHLIGHT=1 ⇒ no coprocess
// and the render falls back to NoopHighlighter (plain <pre><code>) — the same
// fallback the JS side produces when highlightCode returns null, but page-wide;
// the parity gate only passes with the coprocess up, matching bun's shiki
// output. A mid-build coprocess death degrades the REMAINING blocks to the
// plain fallback (logged once).

import ADContent
import ADJSONCore
import Foundation

/// Spawns + talks to the shiki coprocess. `@unchecked Sendable`: all mutable
/// state is guarded by `lock` (the CodeHighlight closure is `@Sendable`).
final class ShikiCoprocess: @unchecked Sendable {
    private let process: Process
    private let requestPipe: Pipe
    private let responsePipe: Pipe
    private let lock = NSLock()
    private var buffer = Data()
    private var nextId = 0
    private var dead = false

    /// Spawn `bun <script>` and wait for the `{"ready":true}` handshake
    /// (grammar warm-up happens before it). nil when the spawn or handshake
    /// fails.
    init?(bunPath: String, scriptPath: String) {
        guard FileManager.default.fileExists(atPath: scriptPath) else { return nil }
        process = Process()
        process.executableURL = URL(fileURLWithPath: bunPath)
        process.arguments = [scriptPath]
        requestPipe = Pipe()
        responsePipe = Pipe()
        process.standardInput = requestPipe
        process.standardOutput = responsePipe
        process.standardError = FileHandle.standardError
        do {
            try process.run()
        } catch {
            return nil
        }
        guard let ready = readLine1(), ready.contains("\"ready\":true") else {
            process.terminate()
            return nil
        }
    }

    deinit {
        shutdown()
    }

    /// Close stdin (the coprocess exits on EOF) and reap it.
    func shutdown() {
        lock.lock()
        defer { lock.unlock() }
        guard !dead else { return }
        dead = true
        try? requestPipe.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
    }

    /// The `CodeHighlight` round-trip: `highlightCode(code, lang)` in the
    /// coprocess. nil ⇒ the caller's plain <pre><code> fallback (unmapped
    /// language / over the size guard / coprocess gone).
    func highlight(code: String, language: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard !dead else { return nil }

        nextId += 1
        let request = JsonLine.request(id: nextId, code: code, lang: language)
        do {
            try requestPipe.fileHandleForWriting.write(contentsOf: Data(request.utf8))
        } catch {
            markDead("write failed")
            return nil
        }
        guard let line = readLine1() else {
            markDead("coprocess closed its pipe")
            return nil
        }
        guard let root = try? ADJSON.parse(line, options: .init(maxDepth: 64)).root else {
            markDead("unparseable response")
            return nil
        }
        // Order-paired; the id is a cross-check against protocol drift.
        if let id = root["id"].int, id != nextId {
            markDead("response id \(id) != request id \(nextId)")
            return nil
        }
        return root["html"].string
    }

    private func markDead(_ reason: String) {
        dead = true
        FileHandle.standardError.write(
            Data("ad-cli: highlight coprocess lost (\(reason)) — remaining code blocks render plain\n".utf8))
        if process.isRunning { process.terminate() }
    }

    /// Read one `\n`-terminated line from the response pipe (blocking).
    private func readLine1() -> String? {
        while true {
            if let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex ..< newline)
                buffer.removeSubrange(buffer.startIndex ... newline)
                return String(decoding: line, as: UTF8.self)
            }
            let chunk = responsePipe.fileHandleForReading.availableData
            if chunk.isEmpty { return nil }  // EOF
            buffer.append(chunk)
        }
    }
}

/// JSONL framing for the request line (JSON string escaping via JsonLine.escape
/// — the coprocess JSON.parses it).
enum JsonLine {
    static func request(id: Int, code: String, lang: String) -> String {
        "{\"id\":\(id),\"code\":\"\(escape(code))\",\"lang\":\"\(escape(lang))\"}\n"
    }

    /// Minimal JSON string escape (quote, backslash, control chars).
    static func escape(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count + 2)
        for scalar in s.unicodeScalars {
            switch scalar {
                case "\"": out += "\\\""
                case "\\": out += "\\\\"
                case "\n": out += "\\n"
                case "\r": out += "\\r"
                case "\t": out += "\\t"
                default:
                    if scalar.value < 0x20 {
                        out += String(format: "\\u%04x", scalar.value)
                    } else {
                        out.unicodeScalars.append(scalar)
                    }
            }
        }
        return out
    }
}

/// Resolve the build-time highlighter: nil (Noop) when highlighting is
/// disabled, bun is absent, or the coprocess fails to start. The returned
/// closure + the coprocess it captures live for the whole build; call
/// `shutdown()` after the build (build.js's disposeHighlighter finally-block).
func resolveHighlighter(srcWebDir: String) -> (highlight: CodeHighlight, coprocess: ShikiCoprocess)? {
    let env = ProcessInfo.processInfo.environment
    if env["APPLE_DOCS_NO_HIGHLIGHT"] == "1" { return nil }
    guard let bun = resolveJsBundler() as? BunBundler else {
        FileHandle.standardError.write(
            Data("ad-cli: no bun on PATH — code blocks render plain (NoopHighlighter)\n".utf8))
        return nil
    }
    // scripts/ sits next to src/ in the checkout `--src-web` points into.
    let scriptPath = "\(srcWebDir)/../../scripts/highlight-server.ts"
    guard let coprocess = ShikiCoprocess(bunPath: bun.bunPath, scriptPath: scriptPath) else {
        FileHandle.standardError.write(
            Data("ad-cli: highlight coprocess failed to start — code blocks render plain\n".utf8))
        return nil
    }
    let closure: CodeHighlight = { code, language in coprocess.highlight(code: code, language: language) }
    return (highlight: closure, coprocess: coprocess)
}

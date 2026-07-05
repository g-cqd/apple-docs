// Spawn fallback for the `hb-view` CLI — the third tier of the render_font_text
// engine chain, JS's `renderFontTextSvgHarfBuzz` (apple-fonts/render.js) ported
// behavior-for-behavior. Tried only when hb-native (`HarfBuzzShaper`, the
// dlopen'd in-process HarfBuzz shim) is unavailable — typically because
// `libharfbuzz.0.dylib`/`.so.0` isn't installed but the `hb-view` binary is (or
// vice versa: a distro can split the runtime library from the CLI tool
// differently). hb-view links the SAME HarfBuzz shaping code, so glyph
// selection/advances match hb-native exactly; only the SVG serialization
// differs (hb-view's own writer, not `HarfBuzzShaper`'s `GlyphPen`), so output
// is tolerance-gated, not byte-identical.
//
// Text travels via a temp FILE, not argv — mirroring the JS comment's exact
// reasoning: argv conversion needs a UTF-8 locale (a C-locale Linux container
// rejects non-ASCII arguments with "Invalid byte sequence"), and a file path
// can never be parsed as an hb-view *option* either.

import Foundation

#if canImport(Darwin)
    import Darwin  // mkdtemp, errno, kill, SIGKILL
#else
    import Glibc
#endif

public enum HbViewRenderer {
    /// `$PATH` lookup for `hb-view`, resolved once per process — mirrors JS's
    /// memoized `Bun.which('hb-view')` probe in `_resolveFontTextEngines`. nil
    /// when the binary isn't installed anywhere on `$PATH`.
    public static let executablePath: String? = locateOnPath("hb-view")

    /// Shape `text` in the font at `fontPath` via the `hb-view` CLI at
    /// `pointSize`, returning the SVG it prints on stdout — or nil on any
    /// failure: no `hb-view` on `$PATH`, a spawn error, a hung process past
    /// `deadlineMs`, a non-zero exit, output with no `<svg>` element, or (for
    /// non-blank input) an `<svg>` with no `<path>` — hb-view exits 0 even when
    /// a corrupt font yields zero outlines, so that last case is treated as a
    /// failed render exactly like the JS oracle does.
    public static func renderSVG(
        fontPath: String, text: String, pointSize: Double, deadlineMs: Int = 10_000
    ) -> String? {
        guard let hbView = executablePath else { return nil }
        guard let stagingDir = try? makeStagingDir() else { return nil }
        defer { try? FileManager.default.removeItem(atPath: stagingDir) }
        let textPath = stagingDir + "/text.txt"
        guard (try? Data(text.utf8).write(to: URL(fileURLWithPath: textPath))) != nil else { return nil }

        let arguments = [
            "--output-format=svg", "--background=FFFFFF00",
            "--font-size=\(Int(pointSize.rounded()))", "--text-file=\(textPath)", fontPath
        ]
        guard let (stdout, exitCode) = run(hbView, arguments: arguments, deadlineMs: deadlineMs),
            exitCode == 0
        else { return nil }

        let svg = String(decoding: stdout, as: UTF8.self)
        guard svg.contains("<svg") else { return nil }
        let hasVisibleText = text.contains { !$0.isWhitespace }
        if hasVisibleText, !svg.contains("<path") { return nil }
        return svg
    }

    // MARK: - subprocess plumbing

    /// Run `executable` with `arguments`, draining stdout on a background
    /// queue (a large SVG payload must not fill the pipe buffer and deadlock
    /// hb-view mid-write while this thread only waits on the exit semaphore)
    /// and SIGKILLing the child past `deadlineMs`. stderr is discarded to
    /// `/dev/null` — this chain never surfaces a per-engine failure reason,
    /// matching the plain nil-on-failure contract `FontText.renderSVG` /
    /// `HarfBuzzShaper.renderSVG` already use.
    ///
    /// Deliberately GCD-based, not async/await: the MCP tool handler that
    /// calls into this chain is itself synchronous (no suspension point to
    /// bridge into here), so `Process.terminationHandler` + a semaphore is the
    /// straightforward seam — the same category of tradeoff `ADOps.RunCmd`
    /// makes for its own (there, `async`) subprocess wait.
    private static func run(
        _ executable: String, arguments: [String], deadlineMs: Int
    ) -> (stdout: Data, exitCode: Int32)? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let outPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = FileHandle.nullDevice

        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        do {
            try process.run()
        } catch {
            return nil
        }

        let output = OutputBox()
        let drained = DispatchGroup()
        drained.enter()
        DispatchQueue.global(qos: .utility)
            .async {
                output.data = outPipe.fileHandleForReading.readDataToEndOfFile()
                drained.leave()
            }

        if exited.wait(timeout: .now() + .milliseconds(deadlineMs)) == .timedOut {
            kill(process.processIdentifier, SIGKILL)
            _ = drained.wait(timeout: .now() + .milliseconds(1_000))
            return nil
        }
        _ = drained.wait(timeout: .now() + .milliseconds(5_000))
        return (output.data, process.terminationStatus)
    }

    /// A private per-call staging dir (mode 0700 via `mkdtemp`) for the text
    /// file — the `ADWrite.Snapshot` idiom, so the path stays unguessable
    /// (closes the symlink-race window a fixed `/tmp/...` name would leave
    /// open on a shared host).
    private static func makeStagingDir() throws -> String {
        let template = NSTemporaryDirectory() + "apple-docs-hb-text-XXXXXX"
        var bytes = Array(template.utf8) + [0]
        let path = bytes.withUnsafeMutableBufferPointer { buffer -> String? in
            buffer.baseAddress.flatMap { mkdtemp($0) }.map { String(cString: $0) }
        }
        guard let path else {
            throw HbViewRendererError.mkdtempFailed(errno: errno)
        }
        return path
    }

    /// `$PATH` lookup for an executable regular file named `name` (the
    /// `Bun.which` equivalent) — the first match wins, matching shell `$PATH`
    /// resolution order.
    private static func locateOnPath(_ name: String) -> String? {
        guard let pathEnv = ProcessInfo.processInfo.environment["PATH"], !pathEnv.isEmpty else { return nil }
        let fm = FileManager.default
        for dir in pathEnv.split(separator: ":") where !dir.isEmpty {
            let candidate = "\(dir)/\(name)"
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: candidate, isDirectory: &isDir), !isDir.boolValue,
                fm.isExecutableFile(atPath: candidate)
            {
                return candidate
            }
        }
        return nil
    }
}

private enum HbViewRendererError: Error {
    case mkdtempFailed(errno: Int32)
}

/// A tiny reference box so the background drain closure in `run` can hand its
/// result back after `DispatchGroup.wait` establishes the happens-before edge
/// — the same pattern `ADOps.RunCmd` uses for its own subprocess result box.
private final class OutputBox: @unchecked Sendable {
    var data = Data()
}

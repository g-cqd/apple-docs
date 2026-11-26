import Foundation

/// Cross-platform SVG-to-PNG rasterizer using scrubbed subprocesses (`rsvg-convert` or `resvg`).
public enum SVGRasterizer: Sendable {
    /// Rasterizes `svg` into a square PNG byte buffer of `size` pixels (clamped to `8...1024`).
    public static func rasterizeToPNG(svg: String, size: Int = 128) async throws(SetupError) -> [UInt8] {
        guard let tool = findRasterizer() else {
            throw .missingHostTool("rsvg-convert or resvg (install librsvg or resvg for PNG rasterization)")
        }
        let clampedSize = max(8, min(size, 1_024))
        return try await SetupScratchDirectory.withDirectory(prefix: "apple-docs-svg") { scratch throws(SetupError) in
            let inputURL = scratch.appendingPathComponent("input.svg")
            let outputURL = scratch.appendingPathComponent("output.png")
            do {
                try Data(svg.utf8).write(to: inputURL, options: .atomic)
            } catch {
                throw .ioFailure("Unable to write temporary SVG: \(error)")
            }
            let args: [String] =
                if tool.hasSuffix("rsvg-convert") {
                    ["-w", String(clampedSize), "-h", String(clampedSize), "-o", outputURL.path, inputURL.path]
                } else {
                    ["--width", String(clampedSize), "--height", String(clampedSize), inputURL.path, outputURL.path]
                }
            _ = try await ScrubbedSubprocess.runChecked(executable: tool, arguments: args)
            do {
                return Array(try Data(contentsOf: outputURL))
            } catch {
                throw .ioFailure("Rasterizer did not produce PNG output: \(error)")
            }
        }
    }

    private static func findRasterizer() -> String? {
        let candidates = [
            "/opt/homebrew/bin/rsvg-convert",
            "/usr/local/bin/rsvg-convert",
            "/usr/bin/rsvg-convert",
            "/opt/homebrew/bin/resvg",
            "/usr/local/bin/resvg",
            "/usr/bin/resvg"
        ]
        let fm = FileManager.default
        return candidates.first { fm.isExecutableFile(atPath: $0) }
    }
}

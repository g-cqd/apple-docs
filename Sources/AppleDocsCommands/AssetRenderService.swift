public import AppleDocsSetup
import AppleDocsSetupDarwin
public import AppleDocsStorage
import Foundation

/// Cross-platform SF Symbols & Apple Font rendering service powering `render_sf_symbol` and
/// `render_font_text` across MCP and CLI.
///
/// - `renderSFSymbolSVG`: reads pre-rendered symbol SVGs from `<resources>/symbols/<scope>/<name>.svg`
///   with strict path-containment validation (`ArchiveSafetyValidator`), recoloring `fill` and
///   sizing `width`/`height` cleanly on both macOS and Linux.
/// - `renderFontTextSVG`: resolves `fontId` in `apple_font_files`, verifies path containment, and
///   renders via CoreText (`DarwinFontRenderer`) on macOS or `hb-view` (`ScrubbedSubprocess`) on Linux.
public enum AssetRenderService: Sendable {
    /// Renders an SF Symbol SVG from `<resourcesDir>/symbols/<scope>/<name>.svg` with validated
    /// color, background, and square pixel size.
    public static func renderSFSymbolSVG(
        name: String,
        scope: String = "public",
        size: Int = 128,
        color: String = "currentColor",
        background: String = "transparent",
        resourcesDirectory: String
    ) throws(SetupError) -> String {
        let validScope = (scope == "private") ? "private" : "public"
        guard isValidSymbolName(name) else {
            throw .unsafeArchiveMember(path: name, reason: "invalid SF Symbol identifier")
        }
        let clampedSize = max(8, min(size, 1_024))
        let safeColor = sanitizeColor(color) ?? "currentColor"
        let safeBg = sanitizeColor(background) ?? "transparent"

        let symbolsRoot = URL(fileURLWithPath: resourcesDirectory, isDirectory: true)
            .appendingPathComponent("symbols", isDirectory: true)
            .path
        let filePath = try ArchiveSafetyValidator.resolveContainedPath(
            relative: "\(validScope)/\(name).svg",
            insideRoot: symbolsRoot
        )
        let rawSVG: String
        do {
            rawSVG = try String(contentsOfFile: filePath, encoding: .utf8)
        } catch {
            throw .ioFailure("Pre-rendered SVG not found for symbol '\(name)' (\(validScope)).")
        }
        return styleSVG(rawSVG, size: clampedSize, color: safeColor, background: safeBg)
    }

    /// Renders `text` with the Apple font identified by `fontID` in `apple_font_files`.
    public static func renderFontTextSVG(
        fontID: String,
        text: String,
        size: Double = 48,
        on connection: SQLiteConnection
    ) async throws -> String {
        guard
            let row = try connection.queryOne(
                "SELECT file_path FROM apple_font_files WHERE id = ? LIMIT 1",
                bindings: [.text(fontID)]
            ),
            let filePath = try row.optionalText(at: 0)
        else {
            throw SetupError.ioFailure("Unknown Apple font id '\(fontID)'.")
        }
        #if os(macOS)
            return try DarwinFontRenderer.renderSVG(fontFilePath: filePath, text: text, pointSize: size)
        #else
            let clamped = Int(max(8, min(size, 512)).rounded())
            let safeText = String(text.prefix(256))
            let outcome = try await ScrubbedSubprocess.run(
                executable: "hb-view",
                arguments: ["--output-format=svg", "--font-size=\(clamped)", filePath, safeText]
            )
            guard outcome.exitCode == 0 else {
                throw SetupError.commandFailed(tool: "hb-view", exitCode: outcome.exitCode, stderr: outcome.stderr)
            }
            return outcome.stdout
        #endif
    }

    /// Validates an SF Symbol name (alphanumeric, `.`, `_`, `-` only; no path separators).
    public static func isValidSymbolName(_ name: String) -> Bool {
        guard !name.isEmpty, name.utf8.count <= 128, !name.hasPrefix("."), !name.contains("..") else {
            return false
        }
        return name.utf8.allSatisfy { b in
            (b >= 0x30 && b <= 0x39)
                || (b >= 0x41 && b <= 0x5A)
                || (b >= 0x61 && b <= 0x7A)
                || b == 0x2E || b == 0x5F || b == 0x2D
        }
    }

    /// Allows `"currentColor"`, `"transparent"`, or `#RGB` / `#RRGGBB` / `#RRGGBBAA` hex colors only.
    public static func sanitizeColor(_ raw: String) -> String? {
        if raw == "currentColor" || raw == "transparent" { return raw }
        guard raw.hasPrefix("#") else { return nil }
        let hex = raw.dropFirst()
        guard hex.count == 3 || hex.count == 6 || hex.count == 8 else { return nil }
        guard
            hex.utf8.allSatisfy({
                ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x46) || ($0 >= 0x61 && $0 <= 0x66)
            })
        else {
            return nil
        }
        return raw
    }

    private static func styleSVG(_ svg: String, size: Int, color: String, background: String) -> String {
        var styled =
            svg
            .replacing("width=\"128\"", with: "width=\"\(size)\"")
            .replacing("height=\"128\"", with: "height=\"\(size)\"")
            .replacing("fill=\"#000000\"", with: "fill=\"\(color)\"")
        if background != "transparent",
            let openEnd = styled.range(
                of: ">",
                range: styled.range(of: "<svg").map { $0.upperBound ..< styled.endIndex }
            )
        {
            styled.insert(
                contentsOf: "<rect width=\"100%\" height=\"100%\" fill=\"\(background)\"/>",
                at: openEnd.upperBound
            )
        }
        return styled
    }
}

// The native Apple font sync — the portable core of src/resources/apple-assets.js
// `syncAppleFonts`. Upserts the 8 Apple font families and indexes every discovered
// font file (variable-axis inspected via FontInspect) into apple_font_families /
// apple_font_files. The DMG download+extract half (`--download-fonts`, hdiutil +
// `pkgutil --expand-full` — Apple's font DMGs wrap their fonts in a .pkg installer)
// is macOS-only and opt-in; this default path — the 8 family rows + system-font
// discovery + already-extracted discovery — is pure Foundation and reproducible.

import ADBase  // Sha256 for the stable file id
import Foundation

#if canImport(FoundationNetworking)
    import FoundationNetworking  // URLSession lives here on Linux (the Foundation split)
#endif

#if canImport(Darwin)
    import Darwin  // kill, SIGKILL (the tool-spawn deadline)
#else
    import Glibc
#endif

/// One of Apple's 8 downloadable font families (the JS APPLE_FONT_FAMILIES rows).
public struct AppleFontFamilyDef: Sendable {
    public let id: String
    public let displayName: String
    public let category: String
    public let sourceUrl: String
    /// Case-insensitive `NSRegularExpression` pattern matching this family's file names.
    public let matchPattern: String
}

public enum FontSync {
    public static let families: [AppleFontFamilyDef] = [
        AppleFontFamilyDef(
            id: "sf-pro", displayName: "SF Pro", category: "sans-serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Pro.dmg",
            matchPattern: #"^SF-Pro(?:-|\.|$)|^SFNS"#),
        AppleFontFamilyDef(
            id: "sf-compact", displayName: "SF Compact", category: "sans-serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Compact.dmg",
            matchPattern: #"^SF-Compact(?:-|\.|$)|^SFCompact"#),
        AppleFontFamilyDef(
            id: "sf-mono", displayName: "SF Mono", category: "monospace",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Mono.dmg",
            matchPattern: #"^SF-Mono(?:-|\.|$)|^SFNSMono"#),
        AppleFontFamilyDef(
            id: "new-york", displayName: "New York", category: "serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/NY.dmg",
            matchPattern: #"^NewYork"#),
        AppleFontFamilyDef(
            id: "sf-arabic", displayName: "SF Arabic", category: "sans-serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Arabic.dmg",
            matchPattern: #"^SF-Arabic(?:-|\.|$)|^SFArabic"#),
        AppleFontFamilyDef(
            id: "sf-armenian", displayName: "SF Armenian", category: "sans-serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Armenian.dmg",
            matchPattern: #"^SF-Armenian(?:-|\.|$)|^SFArmenian"#),
        AppleFontFamilyDef(
            id: "sf-georgian", displayName: "SF Georgian", category: "sans-serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Georgian.dmg",
            matchPattern: #"^SF-Georgian(?:-|\.|$)|^SFGeorgian"#),
        AppleFontFamilyDef(
            id: "sf-hebrew", displayName: "SF Hebrew", category: "sans-serif",
            sourceUrl: "https://devimages-cdn.apple.com/design/resources/download/SF-Hebrew.dmg",
            matchPattern: #"^SF-Hebrew(?:-|\.|$)|^SFHebrew"#)
    ]

    /// The system font search roots (the JS DEFAULT_FONT_DIRS).
    static var defaultFontDirs: [String] {
        ["/Library/Fonts", "/System/Library/Fonts", "\(NSHomeDirectory())/Library/Fonts"]
    }

    private static let fontFilePattern = #"\.(ttf|otf|ttc|dfont)$"#

    /// A discovered font file: its leaf name + absolute path.
    public struct DiscoveredFont: Sendable, Equatable {
        public let fileName: String
        public let filePath: String
    }

    /// Recursive directory walk for font files (the JS `discoverAppleFontFiles` over `walkFiles`,
    /// which recurses — the DMG extractor drops each family's fonts into `extracted/<family>/`, so a
    /// one-level scan of `extracted/` finds nothing). Missing dirs are skipped, `__MACOSX` is pruned,
    /// duplicates are dropped by absolute path (the JS `seen` set), and entries are sorted at each
    /// level so the index order is deterministic across runs (the JS order is filesystem-dependent).
    public static func discover(_ dirs: [String]) -> [DiscoveredFont] {
        var seen: Set<String> = []
        var out: [DiscoveredFont] = []
        for dir in dirs {
            for file in fontFiles(under: dir) where seen.insert(file.filePath).inserted {
                out.append(file)
            }
        }
        return out
    }

    /// The family whose match pattern accepts `fileName`, or nil.
    static func matchFamily(_ fileName: String) -> AppleFontFamilyDef? {
        families.first { matches(fileName, $0.matchPattern) }
    }

    static func matches(_ string: String, _ pattern: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else {
            return false
        }
        return regex.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)) != nil
    }

    /// The tallies `syncAppleFonts` returns.
    public struct Result: Sendable, Equatable {
        public var families = 0
        public var files = 0
        public var variable = 0
        public var system = 0
        public var remote = 0
        /// `--download-fonts` only: DMGs freshly fetched, and font files extracted from them.
        public var downloaded = 0
        public var extracted = 0
    }

    /// Upsert the 8 families, then index every discovered font (already-extracted DMG files first — they
    /// win a `file_name` collision — then system fonts). Requires a writable `StorageConnection` whose
    /// schema is at AppleDocsSchema. `now` is the caller's ISO timestamp. When `downloadFonts` is set
    /// (macOS-only, opt-in), each family's DMG is first fetched to `resources/fonts/original/<id>.dmg`,
    /// hashed + sized, and extracted into `extracted/<id>` before the index pass; a per-family failure is
    /// sunk to `warn` (mirrors the JS `logger?.warn`) so one bad DMG never aborts the whole sync.
    @discardableResult
    public static func syncAppleFonts(
        _ db: StorageConnection, dataDir: String, now: String, downloadFonts: Bool = false,
        warn: ((String) -> Void)? = nil
    ) async -> Result {
        let extractedDir = "\(dataDir)/resources/fonts/extracted"
        var result = Result()
        for family in families {
            let upserted = db.upsertAppleFontFamily(
                AppleFontFamilyUpsert(
                    id: family.id, displayName: family.displayName, category: family.category,
                    sourceUrl: family.sourceUrl, extractedPath: "\(extractedDir)/\(family.id)",
                    status: "available"),
                updatedAt: now)
            if upserted { result.families += 1 }
        }
        // `--download-fonts`: fetch + extract each family's DMG before the index pass, then
        // re-upsert the family as `downloaded` with its source hash/size/path. Mirrors the JS
        // `if (opts.downloadFonts)` block — a per-family failure is logged and skipped, never fatal.
        if downloadFonts {
            let originalsDir = "\(dataDir)/resources/fonts/original"
            ensureDir(originalsDir)
            ensureDir(extractedDir)
            for family in families {
                do {
                    let dmgPath = "\(originalsDir)/\(family.id).dmg"
                    if try await downloadFileIfNeeded(family.sourceUrl, to: dmgPath) { result.downloaded += 1 }
                    let hash = try hashFile(dmgPath)
                    let size = fileSize(dmgPath)
                    let familyDir = "\(extractedDir)/\(family.id)"
                    result.extracted += try extractDmgFonts(dmgPath, to: familyDir, warn: warn).count
                    db.upsertAppleFontFamily(
                        AppleFontFamilyUpsert(
                            id: family.id, displayName: family.displayName, category: family.category,
                            sourceUrl: family.sourceUrl, sourceSha256: hash, sourceSize: size,
                            sourcePath: dmgPath, extractedPath: familyDir, status: "downloaded"),
                        updatedAt: now)
                } catch {
                    warn?("Apple font download/extract failed for \(family.displayName): \(error.localizedDescription)")
                }
            }
        }
        var remoteNames: Set<String> = []
        for file in discover([extractedDir]) {
            guard let family = matchFamily(file.fileName) else { continue }
            index(db, file, family: family, source: "remote", now: now, into: &result)
            remoteNames.insert("\(family.id):\(file.fileName)")
        }
        for file in discover(defaultFontDirs) {
            guard let family = matchFamily(file.fileName),
                !remoteNames.contains("\(family.id):\(file.fileName)")
            else { continue }
            index(db, file, family: family, source: "system", now: now, into: &result)
        }
        return result
    }

    private static func index(
        _ db: StorageConnection, _ file: DiscoveredFont, family: AppleFontFamilyDef, source: String,
        now: String, into result: inout Result
    ) {
        let parsed = FontInspect.parseFilename(file.fileName)
        let sfnt = FontInspect.inspectFile(file.filePath)
        let attrs = try? FileManager.default.attributesOfItem(atPath: file.filePath)
        let size = (attrs?[.size] as? NSNumber)?.int64Value
        let id = String(Sha256.hexString("\(family.id):\(file.fileName)").prefix(24))
        let format = (file.fileName as NSString).pathExtension.lowercased()
        let styleName = parsed.italic ? "\(parsed.weight ?? "Regular") Italic" : parsed.weight
        // Count SUCCESSES only (see SymbolSync's same rule): an attempt-count once
        // masked a query_only connection as a healthy 167-file sync.
        let upserted = db.upsertAppleFontFile(
            AppleFontFileUpsert(
                id: id, familyId: family.id, fileName: file.fileName, filePath: file.filePath,
                styleName: styleName, weight: parsed.weight, variant: parsed.variant, italic: parsed.italic,
                format: format.isEmpty ? nil : format, source: source, isVariable: sfnt.isVariable,
                axesJson: axesJSON(sfnt.axes), sha256: nil, size: size),
            updatedAt: now)
        guard upserted else { return }
        if sfnt.isVariable { result.variable += 1 }
        if source == "remote" { result.remote += 1 }
        if source == "system" { result.system += 1 }
        result.files += 1
    }

    /// JS-compatible axes JSON — `[]` for a static font, else
    /// `[{"tag":"wght","min":0,"default":400,"max":900}]`, integer values without a trailing `.0`
    /// (matching `JSON.stringify` of the JS axis objects, so the corpus row is byte-identical).
    static func axesJSON(_ axes: [FontInspect.Axis]) -> String {
        let items = axes.map { axis in
            "{\"tag\":\"\(axis.tag)\",\"min\":\(number(axis.min)),\"default\":\(number(axis.def)),"
                + "\"max\":\(number(axis.max))}"
        }
        return "[\(items.joined(separator: ","))]"
    }

    private static func number(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int64(value)) : String(value)
    }
}

// MARK: - DMG download + extract (`--download-fonts`, macOS-only)
//
// The native port of src/resources/apple-fonts/sync.js's downloadFileIfNeeded /
// extractDmgFonts / hashFile — reached only under `--download-fonts`. The hdiutil mount
// makes it macOS-only. ADStorage can't reach ADOps' GhRelease / SHA256Hex without
// inverting the module layering, so these reimplement the same shape over Foundation +
// ADBase.Sha256. (A same-file extension: the enum body stays within the size gate.)
extension FontSync {
    /// GET `url` to `filePath` when it's absent or empty; returns whether it downloaded (the JS
    /// `downloadFileIfNeeded`). `URLSession.downloadTask` streams the body to a temp file (bounded
    /// memory — the DMGs are tens of MB), moved into place so `filePath` only appears complete.
    static func downloadFileIfNeeded(_ url: String, to filePath: String) async throws -> Bool {
        if fileSize(filePath) > 0 { return false }  // present + non-empty ⇒ skip (JS existsSync && size > 0)
        ensureDir((filePath as NSString).deletingLastPathComponent)
        guard let requestURL = URL(string: url) else { throw FontSyncError("invalid url \(url)") }
        var request = URLRequest(url: requestURL)
        request.timeoutInterval = 300  // JS AbortSignal.timeout(300_000)
        let session = URLSession(configuration: .ephemeral)
        // The handler's temp file is deleted when it returns, so move it aside first.
        let (staged, status): (URL, Int) = try await withCheckedThrowingContinuation { continuation in
            let task = session.downloadTask(with: request) { location, response, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let location else {
                    continuation.resume(throwing: FontSyncError("download produced no file for \(url)"))
                    return
                }
                let kept = location.deletingLastPathComponent()
                    .appendingPathComponent("adcli-font-\(UUID().uuidString)")
                do {
                    try FileManager.default.moveItem(at: location, to: kept)
                } catch {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: (kept, (response as? HTTPURLResponse)?.statusCode ?? 0))
            }
            task.resume()
        }
        guard (200 ..< 300).contains(status) else {
            try? FileManager.default.removeItem(at: staged)
            throw FontSyncError("HTTP \(status) downloading \(url)")
        }
        let destination = URL(fileURLWithPath: filePath)
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: staged, to: destination)
        return true
    }

    /// Attach `dmgPath` read-only, expand every `.pkg` installer found on the mounted volume(s)
    /// (`pkgutil --expand-full` into a scratch dir — Apple's downloadable font DMGs ship their fonts
    /// INSIDE a `.pkg`, not loose on the volume, so without this step every family extracts 0 fonts),
    /// copy every font file found across the mounts + the expanded payloads into `destinationDir`,
    /// and always detach + clean up (the JS `extractDmgFonts`); returns the copied target paths.
    /// `-plist` with NO forced `-mountpoint` + enumerate-every-mount handles the SLA-wrapped /
    /// multi-volume Apple DMGs (forcing one mountpoint latched the wrong volume in the JS); a failed
    /// pkg expand is warn-and-skip, never fatal; `warn` also surfaces a detach leak that would
    /// otherwise be silent.
    static func extractDmgFonts(
        _ dmgPath: String, to destinationDir: String, warn: ((String) -> Void)? = nil
    ) throws -> [String] {
        ensureDir(destinationDir)
        // The pkg-payload scratch dir (the JS `mkdtemp(join(tmpdir(), 'apple-docs-font-pkg-'))`).
        // Registered for cleanup FIRST so the LIFO defers replay the JS finally order: detach every
        // mount, then remove the expanded payloads.
        let expandedDir = try makeScratchDir()
        defer { try? FileManager.default.removeItem(atPath: expandedDir) }
        let plist = try runTool(
            hdiutilPath, ["attach", "-readonly", "-nobrowse", "-noautoopen", "-plist", dmgPath])
        let mountPoints = try parseMountPoints(plist)
        guard !mountPoints.isEmpty else {
            // The attach may have mounted something we failed to parse — surface it rather than
            // silently shipping a font-less extraction (the JS ValidationError).
            throw FontSyncError("hdiutil attached \(dmgPath) but no mount point was parsed")
        }
        defer {
            for mount in mountPoints {
                // Best-effort, like the JS `.catch(() => {})` — but surface a leak via `warn`.
                do { _ = try runTool(hdiutilPath, ["detach", mount]) } catch {
                    warn?("hdiutil detach failed for \(mount): \(error.localizedDescription)")
                }
            }
        }
        expandPkgs(on: mountPoints, into: expandedDir, warn: warn)
        // Discover across every mount + the expanded payloads (the JS
        // `discoverAppleFontFiles([...mountPoints, expandedDir])` — dedup by absolute path), then
        // sort by file name so the extracted set + copy order is deterministic (the walk order is
        // filesystem-dependent). Mirrors the JS.
        var extracted: [String] = []
        for source in discover(mountPoints + [expandedDir]).sorted(by: { $0.fileName < $1.fileName }) {
            let target = "\(destinationDir)/\(source.fileName)"
            try? FileManager.default.removeItem(atPath: target)  // copyItem won't overwrite; JS copyFile does
            try FileManager.default.copyItem(atPath: source.filePath, toPath: target)
            extracted.append(target)
        }
        return extracted
    }

    /// Expand every `.pkg` found under the mounted volumes into `expandedDir` via
    /// `pkgutil --expand-full` (the JS loop over `findByExtension(mp, '.pkg')`). Each pkg lands in a
    /// subdirectory named after its sanitized basename; a failed expand is a warn-and-skip, never
    /// fatal (one bad installer must not abort the family, let alone the sync).
    private static func expandPkgs(
        on mountPoints: [String], into expandedDir: String, warn: ((String) -> Void)?
    ) {
        for mount in mountPoints {
            for pkg in filesByExtension(under: mount, extension: "pkg") {
                let out = "\(expandedDir)/\(sanitizeFileName((pkg as NSString).lastPathComponent))"
                do {
                    _ = try runTool(pkgutilPath, ["--expand-full", pkg, out])
                } catch {
                    warn?("pkgutil failed for \(pkg): \(error.localizedDescription)")
                }
            }
        }
    }

    /// `apple-assets-helpers.js` `sanitizeFileName`: every run of characters outside
    /// `[a-z0-9_.-]` (case-insensitive) collapses to one `-`, leading/trailing `-` runs are
    /// stripped, and an empty result falls back to `"asset"`.
    static func sanitizeFileName(_ value: String) -> String {
        var out = ""
        var pendingDash = false
        for char in value {
            let allowed =
                char.isASCII && (char.isLetter || char.isNumber || char == "_" || char == "." || char == "-")
            if allowed {
                if pendingDash, !out.isEmpty { out.append("-") }
                pendingDash = false
                out.append(char)
            } else {
                pendingDash = true
            }
        }
        while out.hasPrefix("-") { out.removeFirst() }
        while out.hasSuffix("-") { out.removeLast() }
        return out.isEmpty ? "asset" : out
    }

    /// SHA-256 hex of the whole file (the JS `hashFile` → `sha256(arrayBuffer)`). Reads the file
    /// wholly, matching the JS; ADBase.Sha256 exposes no streaming entry point.
    static func hashFile(_ path: String) throws -> String {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        return Sha256.hex(Sha256.digest([UInt8](data)))
    }

    /// Every `mount-point` string in a `hdiutil attach -plist` payload (its `system-entities` array);
    /// whole-disk entities carry none and are skipped, so the result is exactly the mounted
    /// filesystems (the JS `parseHdiutilMountPoints`, but over PropertyListSerialization not a regex).
    private static func parseMountPoints(_ data: Data) throws -> [String] {
        let plist = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        guard let root = plist as? [String: Any], let entities = root["system-entities"] as? [[String: Any]]
        else { return [] }
        return entities.compactMap { entity in
            guard
                let mount = (entity["mount-point"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines), !mount.isEmpty
            else { return nil }
            return mount
        }
    }

    static let hdiutilPath = "/usr/bin/hdiutil"
    static let pkgutilPath = "/usr/sbin/pkgutil"

    /// Run `executable args…` and return its stdout, throwing its stderr on a non-zero exit (the JS
    /// `run` / `runCapture` over `spawnWithDeadline`). Both pipes drain on background queues so
    /// output larger than a pipe buffer can never wedge the child, and the child is SIGKILLed past
    /// `deadlineMs` (the JS bounds hdiutil attach/detach and `pkgutil --expand-full` at the same 60s
    /// — each finishes in seconds on a normal DMG, so the deadline only bounds an OS-level hang; the
    /// drain-then-deadline shape follows `ADRender.HbViewRenderer.run`).
    private static func runTool(_ executable: String, _ args: [String], deadlineMs: Int = 60_000) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        do {
            try process.run()
        } catch {
            throw FontSyncError("cannot spawn \(executable): \(error.localizedDescription)")
        }
        let stdout = PipeDrain(outPipe)
        let stderr = PipeDrain(errPipe)
        if exited.wait(timeout: .now() + .milliseconds(deadlineMs)) == .timedOut {
            kill(process.processIdentifier, SIGKILL)
            _ = stdout.wait(ms: 1_000)
            _ = stderr.wait(ms: 1_000)
            throw FontSyncError("\(executable) timed out after \(deadlineMs / 1_000)s")
        }
        _ = stdout.wait(ms: 5_000)
        _ = stderr.wait(ms: 5_000)
        guard process.terminationStatus == 0 else {
            let message = String(decoding: stderr.data, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw FontSyncError(
                message.isEmpty
                    ? "\((executable as NSString).lastPathComponent) exited \(process.terminationStatus)"
                    : message)
        }
        return stdout.data
    }

    /// A fresh private scratch directory for the expanded pkg payloads (`mkdtemp`, mode 0700 —
    /// the `HbViewRenderer.makeStagingDir` idiom, unguessable so no fixed-name symlink race).
    private static func makeScratchDir() throws -> String {
        let template = NSTemporaryDirectory() + "apple-docs-font-pkg-XXXXXX"
        var bytes = Array(template.utf8) + [0]
        let path = bytes.withUnsafeMutableBufferPointer { buffer -> String? in
            buffer.baseAddress.flatMap { mkdtemp($0) }.map { String(cString: $0) }
        }
        guard let path else { throw FontSyncError("mkdtemp failed (errno \(errno))") }
        return path
    }

    /// Every font file under `dir` (recursive) — the JS `walkFiles` filter behind
    /// `discoverAppleFontFiles`.
    private static func fontFiles(under dir: String) -> [DiscoveredFont] {
        var out: [DiscoveredFont] = []
        walkFiles(under: dir) { name, full in
            if matches(name, fontFilePattern) { out.append(DiscoveredFont(fileName: name, filePath: full)) }
        }
        return out
    }

    /// Every file under `dir` whose lowercased path extension is `ext` (the JS `findByExtension`,
    /// which feeds the `.pkg` expansion).
    private static func filesByExtension(under dir: String, extension ext: String) -> [String] {
        var out: [String] = []
        walkFiles(under: dir) { name, full in
            if (name as NSString).pathExtension.lowercased() == ext { out.append(full) }
        }
        return out
    }

    /// Recursive file walk (the JS `walkFiles`): visits every regular file under `dir` as
    /// `(leafName, fullPath)`, pruning `__MACOSX`. Entries are sorted at each level so every
    /// consumer's order is deterministic (the JS readdir order is filesystem-dependent).
    private static func walkFiles(under dir: String, _ visit: (String, String) -> Void) {
        let fileManager = FileManager.default
        guard let entries = try? fileManager.contentsOfDirectory(atPath: dir) else { return }
        for name in entries.sorted() {
            let full = "\(dir)/\(name)"
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: full, isDirectory: &isDirectory) else { continue }
            if isDirectory.boolValue {
                if name != "__MACOSX" { walkFiles(under: full, visit) }
            } else {
                visit(name, full)
            }
        }
    }

    /// `mkdir -p` (the JS `ensureDir`).
    private static func ensureDir(_ path: String) {
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }

    /// Size of the file at `path` in bytes, 0 when absent (the JS `statSync(...).size`; its call
    /// sites here run only after the file is known present).
    private static func fileSize(_ path: String) -> Int64 {
        (try? FileManager.default.attributesOfItem(atPath: path)).flatMap { $0[.size] as? NSNumber }?
            .int64Value ?? 0
    }
}

/// A download/extract failure surfaced to `syncAppleFonts`' per-family `warn` sink (the JS
/// `HttpError` / `ValidationError` from sync.js — always caught + logged, never propagated).
private struct FontSyncError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// Drains one pipe to EOF on a background queue (`HbViewRenderer`'s OutputBox + DispatchGroup
/// pattern): the caller waits on process exit without ever blocking a pipe writer, then `wait`
/// establishes the happens-before edge for reading `data`.
private final class PipeDrain: @unchecked Sendable {
    var data = Data()
    private let drained = DispatchGroup()

    init(_ pipe: Pipe) {
        drained.enter()
        DispatchQueue.global(qos: .utility)
            .async {
                self.data = pipe.fileHandleForReading.readDataToEndOfFile()
                self.drained.leave()
            }
    }

    /// True when the drain finished within `ms`.
    @discardableResult
    func wait(ms: Int) -> Bool {
        drained.wait(timeout: .now() + .milliseconds(ms)) == .success
    }
}

// The native Apple font sync — the portable core of src/resources/apple-assets.js
// `syncAppleFonts`. Upserts the 8 Apple font families and indexes every discovered
// font file (variable-axis inspected via FontInspect) into apple_font_families /
// apple_font_files. The DMG download+extract half (`--download-fonts`, hdiutil) is
// macOS-only and opt-in; this default path — the 8 family rows + system-font
// discovery + already-extracted discovery — is pure Foundation and reproducible.

import ADBase  // Sha256 for the stable file id
import Foundation

#if canImport(FoundationNetworking)
    import FoundationNetworking  // URLSession lives here on Linux (the Foundation split)
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

    /// One-level directory walk for font files (the JS `discoverAppleFontFiles`). Missing dirs are
    /// skipped; entries are sorted so the index order is deterministic across runs.
    public static func discover(_ dirs: [String]) -> [DiscoveredFont] {
        var out: [DiscoveredFont] = []
        for dir in dirs {
            guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir) else { continue }
            for name in entries.sorted() where matches(name, fontFilePattern) {
                out.append(DiscoveredFont(fileName: name, filePath: "\(dir)/\(name)"))
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
        result.families = families.count
        for family in families {
            db.upsertAppleFontFamily(
                AppleFontFamilyUpsert(
                    id: family.id, displayName: family.displayName, category: family.category,
                    sourceUrl: family.sourceUrl, extractedPath: "\(extractedDir)/\(family.id)",
                    status: "available"),
                updatedAt: now)
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
        db.upsertAppleFontFile(
            AppleFontFileUpsert(
                id: id, familyId: family.id, fileName: file.fileName, filePath: file.filePath,
                styleName: styleName, weight: parsed.weight, variant: parsed.variant, italic: parsed.italic,
                format: format.isEmpty ? nil : format, source: source, isVariable: sfnt.isVariable,
                axesJson: axesJSON(sfnt.axes), sha256: nil, size: size),
            updatedAt: now)
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

    // MARK: - DMG download + extract (`--download-fonts`, macOS-only)
    //
    // The native port of src/resources/apple-fonts/sync.js's downloadFileIfNeeded /
    // extractDmgFonts / hashFile — reached only under `--download-fonts`. The hdiutil mount
    // makes it macOS-only. ADStorage can't reach ADOps' GhRelease / SHA256Hex without
    // inverting the module layering, so these reimplement the same shape over Foundation +
    // ADBase.Sha256.

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

    /// Attach `dmgPath` read-only, copy every font file found under the mounted volume(s) into
    /// `destinationDir`, and always detach (the JS `extractDmgFonts`); returns the copied target
    /// paths. `-plist` with NO forced `-mountpoint` + enumerate-every-mount handles the SLA-wrapped /
    /// multi-volume Apple DMGs (forcing one mountpoint latched the wrong volume in the JS); `warn`
    /// surfaces a detach leak that would otherwise be silent.
    static func extractDmgFonts(
        _ dmgPath: String, to destinationDir: String, warn: ((String) -> Void)? = nil
    ) throws -> [String] {
        ensureDir(destinationDir)
        let plist = try runHdiutil(["attach", "-readonly", "-nobrowse", "-noautoopen", "-plist", dmgPath])
        let mountPoints = try parseMountPoints(plist)
        guard !mountPoints.isEmpty else {
            // The attach may have mounted something we failed to parse — surface it rather than
            // silently shipping a font-less extraction (the JS ValidationError).
            throw FontSyncError("hdiutil attached \(dmgPath) but no mount point was parsed")
        }
        defer {
            for mount in mountPoints {
                // Best-effort, like the JS `.catch(() => {})` — but surface a leak via `warn`.
                do { _ = try runHdiutil(["detach", mount]) } catch {
                    warn?("hdiutil detach failed for \(mount): \(error.localizedDescription)")
                }
            }
        }
        // Dedup by absolute path + sort by file name so the copied set and order are deterministic
        // (the walk order is filesystem-dependent). Mirrors the JS.
        var seen: Set<String> = []
        var sources: [DiscoveredFont] = []
        for mount in mountPoints {
            for file in fontFiles(under: mount) where seen.insert(file.filePath).inserted {
                sources.append(file)
            }
        }
        var extracted: [String] = []
        for source in sources.sorted(by: { $0.fileName < $1.fileName }) {
            let target = "\(destinationDir)/\(source.fileName)"
            try? FileManager.default.removeItem(atPath: target)  // copyItem won't overwrite; JS copyFile does
            try FileManager.default.copyItem(atPath: source.filePath, toPath: target)
            extracted.append(target)
        }
        return extracted
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

    /// Run `/usr/bin/hdiutil <args>` and return its stdout, throwing its stderr on a non-zero exit
    /// (the JS `run` / `runCapture`). stdout is drained before the wait so a plist larger than the
    /// pipe buffer can't wedge the child — hdiutil's output here is small either way.
    private static func runHdiutil(_ args: [String]) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        process.arguments = args
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        do {
            try process.run()
        } catch {
            throw FontSyncError("cannot spawn hdiutil: \(error.localizedDescription)")
        }
        let out = outPipe.fileHandleForReading.readDataToEndOfFile()
        let err = errPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let message = String(decoding: err, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw FontSyncError(message.isEmpty ? "hdiutil exited \(process.terminationStatus)" : message)
        }
        return out
    }

    /// Every font file under `dir` (recursive; skips `__MACOSX`) — the JS `walkFiles` /
    /// `discoverAppleFontFiles` the extractor copies from. The one-level `discover` above is for the
    /// flat extracted/ + system dirs; a mounted DMG nests its fonts.
    private static func fontFiles(under dir: String) -> [DiscoveredFont] {
        let fileManager = FileManager.default
        guard let entries = try? fileManager.contentsOfDirectory(atPath: dir) else { return [] }
        var out: [DiscoveredFont] = []
        for name in entries {
            let full = "\(dir)/\(name)"
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: full, isDirectory: &isDirectory) else { continue }
            if isDirectory.boolValue {
                if name != "__MACOSX" { out.append(contentsOf: fontFiles(under: full)) }
            } else if matches(name, fontFilePattern) {
                out.append(DiscoveredFont(fileName: name, filePath: full))
            }
        }
        return out
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

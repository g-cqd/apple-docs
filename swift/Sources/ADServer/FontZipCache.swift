// On-disk cache plumbing for `/api/fonts/family/:id.zip`: the `?subset=` filter enum, the
// subset predicate over `AppleFontFile`, and the file-stat + atomic-write helpers the route uses
// to persist a built ZIP to `<dataDir>/resources/fonts/zips/` (a Swift port of the JS route's
// temp-file-then-rename cache-write pattern).

import ADStorage
import Foundation

/// `?subset=` values `/api/fonts/family/:id.zip` recognizes (JS: `variable|static|remote|system`,
/// default/unrecognized `all`).
///
/// Unlike JS — which falls an unrecognized value through to "all" FILTERING but still embeds the
/// RAW query string into the on-disk cache filename (`${familyId}${fileNameSuffix}-${hash}.zip`
/// via `path.join`) — an unrecognized value here normalizes to `.all` for the filename too,
/// closing a latent path-traversal risk: a `subset` value containing `/` or `..` could otherwise
/// smuggle itself into the cache path. Every legitimate input (`variable`/`static`/`remote`/
/// `system`/`all`, case-insensitive) behaves identically to JS.
enum FontZipSubset: String {
    case variable
    case `static`
    case remote
    case system
    case all

    init(query: String?) {
        self = (query?.lowercased()).flatMap(FontZipSubset.init(rawValue:)) ?? .all
    }
}

/// One source file that passed containment + existence checks, ready to fingerprint and zip. A
/// named struct rather than a 4-element tuple (over the project's `large_tuple` lint budget).
struct SafeFontFile {
    let name: String
    let path: String
    let size: Int
    let mtime: Int
}

/// The `?subset=` filter predicate (JS `fontFamilyZipHandler`'s inline `switch`).
func matchesFontSubset(_ file: AppleFontFile, _ subset: FontZipSubset) -> Bool {
    switch subset {
        case .variable: return file.isVariable
        case .static: return !file.isVariable
        case .remote: return file.source == "remote"
        case .system: return file.source == "system"
        case .all: return true
    }
}

/// (byte size, whole-second mtime) for `path`, or nil if it can't be stat'd — mirrors the JS
/// route's `Bun.file(path).exists()` skip-if-missing behavior (a source file that vanished
/// between the DB read and this stat is silently excluded, not a hard failure).
func fontFileStat(_ path: String) -> (size: Int, mtime: Int)? {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path) else { return nil }
    let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
    let mtime = Int(((attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0).rounded())
    return (size, mtime)
}

/// Write `bytes` to `finalPath` via a temp-file + rename so a partial write is never observable
/// at `finalPath` — a concurrent reader sees either the old file or the fully-written new one,
/// and two concurrent builders racing the same cache miss just rename over each other (last
/// writer wins), the same race JS's own `Bun.write(tempPath)` + `renameSync` accepts. Best-effort:
/// a write failure leaves the route to rebuild on the next request rather than fail this one (no
/// per-request logger is threaded to this pure cache helper, so failures are silent here — the
/// same "caching must not fail the response" contract JS documents, just without the warn log).
func writeFontZipAtomically(_ bytes: [UInt8], to finalPath: String, in directory: String) {
    if !FileManager.default.fileExists(atPath: directory) {
        guard (try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)) != nil
        else { return }
    }
    let tempPath = "\(finalPath).\(ProcessInfo.processInfo.processIdentifier).\(UUID().uuidString).tmp"
    guard FileManager.default.createFile(atPath: tempPath, contents: Data(bytes)) else { return }
    _ = try? FileManager.default.removeItem(atPath: finalPath)
    do {
        try FileManager.default.moveItem(atPath: tempPath, toPath: finalPath)
    } catch {
        _ = try? FileManager.default.removeItem(atPath: tempPath)
    }
}

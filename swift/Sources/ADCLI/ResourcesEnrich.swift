// `ad-cli resources enrich` — enrich `documents` from Xcode's offline Developer
// Documentation MobileAsset (com.apple.MobileAsset.AppleDeveloperDocumentation).
// Ports the sync enrichment phase (src/commands/sync/enrich.js `runEnrichPhase` →
// src/sources/mobileasset-docs.js `enrichFromAsset`): backfill `usr` and
// `platforms_json`/min_* where NULL, insert novel pages through the normal
// documents upsert (FTS triggers + sections), skip `#anchor` rows.
//
// Asset resolution policy (the JS `resolveAssetDb`):
//   - explicit `--asset-db` (tests / tooling) wins;
//   - else a locally-installed Xcode asset when present;
//   - else skip — non-fatal by design (exit 0), the corpus is complete without
//     it. The JS gates an optional CDN download behind APPLE_DOCS_ENRICH_FETCH=1
//     (~650 MB); the env gate is mirrored, but the download itself is not ported
//     — with the gate set and no local asset the verb still skips (exit 0) and
//     says so, pointing at the JS sync.

import ADJSONCore
import ADStorage
import ArgumentParser
import Foundation

/// `ad-cli resources enrich [--db …] [--home …] [--asset-db …] [--asset-root …] [--dry-run] [--json]`.
struct ResourcesEnrichCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "enrich",
        abstract: "Enrich documents from Xcode's offline Developer Documentation MobileAsset.")

    @Option(name: .long, help: "Path to the writable corpus DB (default: <home>/apple-docs.db).")
    var db: String?

    @Option(name: .long, help: "Corpus home (default: $APPLE_DOCS_HOME, else ~/.apple-docs).")
    var home: String?

    @Option(
        name: .customLong("asset-db"),
        help: "Explicit asset index.sql path (default: the newest installed Xcode documentation asset).")
    var assetDb: String?

    @Option(
        name: .customLong("asset-root"),
        help: "MobileAsset root to scan for installed documentation assets.")
    var assetRoot: String = MobileAssetDocs.defaultAssetRoot

    @Flag(name: .customLong("dry-run"), help: "Compute the merge counts without writing.")
    var dryRun = false

    @Flag(name: .long, help: "Emit the result as JSON.")
    var json = false

    func run() throws {
        let dataDir =
            home ?? ProcessInfo.processInfo.environment["APPLE_DOCS_HOME"]
            ?? "\(NSHomeDirectory())/.apple-docs"
        let dbPath = db ?? "\(dataDir)/apple-docs.db"
        guard let assetDbPath = resolveAssetDb() else { return }  // reported + exit 0 (the JS skip)
        // writable: the enrichment IS a write pass; the default read connection is
        // PRAGMA query_only post-pivot (D-0007-4), under which every write silently fails.
        guard let connection = StorageConnection(path: dbPath, writable: true) else {
            FileHandle.standardError.write(Data("ad-cli: cannot open corpus \(dbPath)\n".utf8))
            throw ExitCode(1)
        }
        let stats = try MobileAssetDocs.enrichFromAsset(
            connection, assetDbPath: assetDbPath, apply: !dryRun, now: jsIsoNow())
        if json {
            print(
                stringifyPretty(
                    .obj([
                        ("pages", .int(Int64(stats.pages))),
                        ("anchorsSkipped", .int(Int64(stats.anchorsSkipped))),
                        ("usrBackfilled", .int(Int64(stats.usrBackfilled))),
                        ("platformsBackfilled", .int(Int64(stats.platformsBackfilled))),
                        ("novelInserted", .int(Int64(stats.novelInserted)))
                    ])))
        } else {
            // The JS log line: `xcode-docs merge${dry}: N USRs, M platform backfills, …`.
            let dry = dryRun ? " (dry-run)" : ""
            print(
                "enrich\(dry): \(stats.usrBackfilled) USRs, "
                    + "\(stats.platformsBackfilled) platform backfills, \(stats.novelInserted) novel pages "
                    + "(\(stats.anchorsSkipped) section anchors skipped)")
        }
    }

    /// The JS `resolveAssetDb`: `--asset-db` → newest local asset → the env-gated skip. Returns
    /// nil after reporting a skip (soft, exit 0 — enrichment is non-fatal by design).
    private func resolveAssetDb() -> String? {
        if let assetDb { return assetDb }
        if let local = MobileAssetDocs.findDocumentationAssets(rootDir: assetRoot).first {
            info("Enriching from local Xcode documentation asset (\(local.docs) pages).")
            return local.dbPath
        }
        let fetchGate = ProcessInfo.processInfo.environment["APPLE_DOCS_ENRICH_FETCH"] == "1"
        let reason =
            fetchGate
            ? "No local Xcode documentation asset; APPLE_DOCS_ENRICH_FETCH=1 is set but the native CLI "
                + "does not port the CDN download — install the asset via Xcode or run the JS sync."
            : "No local Xcode documentation asset — skipping enrichment "
                + "(APPLE_DOCS_ENRICH_FETCH=1 enables the CDN download in the JS sync)."
        if json {
            print(stringifyPretty(.obj([("skipped", .bool(true)), ("reason", .string(reason))])))
        } else {
            print("enrich: skipped — \(reason)")
        }
        return nil
    }

    private func info(_ message: String) {
        FileHandle.standardError.write(Data("ad-cli: \(message)\n".utf8))
    }
}

import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import AppleDocsStorage
import Foundation

/// Static site generator: renders the same pages as `web serve` into a self-contained directory tree
/// (HTML, assets, sitemaps, symbol SVGs, discovery files) with bounded parallel page rendering, built in a
/// private staging directory and published by an atomic directory swap (see ``StaticSiteOutput``).
public enum StaticSiteBuilder: Sendable {
    /// Marker file identifying a directory as a previous export (only such directories are replaced).
    public static let markerFileName = ".apple-docs-site"

    /// Why an export failed.
    public enum BuildError: Error, Hashable, Sendable, CustomStringConvertible {
        case unsafeOutputDirectory(String)
        case unsafePath(String)
        case io(String)
        case database(String)

        public var description: String {
            switch self {
                case .unsafeOutputDirectory(let path):
                    "refusing to replace \(path): it is not empty and not a previous apple-docs export"
                case .unsafePath(let path): "unsafe output path: \(path)"
                case .io(let reason): "I/O error: \(reason)"
                case .database(let reason): "database error: \(reason)"
            }
        }
    }

    /// Export settings.
    public struct Options: Sendable {
        public var framework: String?
        public var limit: Int
        public var site: WebSiteConfiguration
        public var resourcesDirectory: String?
        public var concurrency: Int

        public init(
            framework: String? = nil,
            limit: Int = 1_000,
            site: WebSiteConfiguration = WebSiteConfiguration(),
            resourcesDirectory: String? = nil,
            concurrency: Int? = nil
        ) {
            self.framework = framework?.lowercased()
            self.limit = max(1, min(limit, 1_000_000))
            self.site = site
            self.resourcesDirectory = resourcesDirectory
            self.concurrency = max(1, min(concurrency ?? min(8, ProcessInfo.processInfo.activeProcessorCount), 64))
        }
    }

    /// What an export produced.
    public struct BuildReport: Hashable, Sendable {
        public let frameworksExported: Int
        /// Document pages plus framework landing pages written.
        public let pagesExported: Int
        /// Pages that could not be rendered or written (the export still completes).
        public let failures: Int
        public let outputDirectory: String
    }

    /// Exports the site for `databasePath` into `outputDirectory`, replacing a previous export atomically.
    public static func build(
        databasePath: String,
        outputDirectory: String,
        options: Options = Options()
    ) async throws -> BuildReport {
        let output = try StaticSiteOutput(
            outputDirectory: outputDirectory,
            markerFileName: markerFileName,
            site: options.site
        )
        do {
            let report = try await populate(output, databasePath: databasePath, options: options)
            try output.commit()
            return report
        } catch {
            output.discard()
            throw error
        }
    }

    private static func populate(
        _ output: StaticSiteOutput,
        databasePath: String,
        options: Options
    ) async throws -> BuildReport {
        let plan = try ExportPlan.load(databasePath: databasePath, options: options)
        let pages = try await exportPages(
            plan.pageKeys,
            roots: plan.roots,
            databasePath: databasePath,
            output: output,
            concurrency: options.concurrency
        )
        try writeSiteFiles(
            plan: plan,
            exportedKeys: pages.exported,
            databasePath: databasePath,
            output: output,
            options: options
        )
        return BuildReport(
            frameworksExported: plan.frameworks.count,
            pagesExported: pages.exported.count,
            failures: pages.failures,
            outputDirectory: output.final.path
        )
    }
}

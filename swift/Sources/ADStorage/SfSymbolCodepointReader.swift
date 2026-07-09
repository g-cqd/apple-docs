// The in-process codepoint extraction engine. Compiles the `@_cdecl` helper
// (SfSymbolCodepointWorkerSource) into a dylib ONCE — cached under the data dir,
// keyed by app version + host arch + a source fingerprint — then `dlopen`s it and
// binds `adsym_open` / `adsym_lookup` / `adsym_close` by `dlsym`, exactly the
// runtime-binding idiom of ADStorage/SQLiteLib.swift + ADRender/HarfBuzzShaper.swift.
//
// This is the native replacement for the JS spawned swift-script worker
// (codepoint-dump.js): no per-run `swiftc` JIT (the dylib is cached across runs), no
// subprocess at stamp time (the reader lives in ad-cli's own address space), and no
// per-symbol stdin/stdout IPC — `lookup` is a direct C call. Every failure edge
// (missing `swiftc`, compile error, `dlopen`/`dlsym` miss, a reader init that throws
// because the decrypt shape or font changed) returns nil so the caller degrades to
// "warn + stamp nothing", never a crash.

import ADBase  // Sha256 — cache-key fingerprint
import Foundation

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

/// A live SF Symbol → PUA-codepoint reader backed by a `dlopen`d helper dylib. Not `Sendable`:
/// owns raw handles and is driven synchronously from one thread (the stamp verb's `run`).
public final class SfSymbolCodepointReader {
    private typealias LookupFn = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?) -> UInt32
    private typealias CloseFn = @convention(c) (UnsafeMutableRawPointer?) -> Void

    private let dylibHandle: UnsafeMutableRawPointer
    private let readerHandle: UnsafeMutableRawPointer
    private let lookupFn: LookupFn
    private let closeFn: CloseFn
    private var closed = false

    private init(
        dylibHandle: UnsafeMutableRawPointer, readerHandle: UnsafeMutableRawPointer,
        lookupFn: @escaping LookupFn, closeFn: @escaping CloseFn
    ) {
        self.dylibHandle = dylibHandle
        self.readerHandle = readerHandle
        self.lookupFn = lookupFn
        self.closeFn = closeFn
    }

    deinit { close() }

    /// The three PUA blocks a valid SF Symbol codepoint must fall in (the JS `PUA_RANGES` /
    /// `isPrivateUseCodepoint`): BMP PUA + the two supplementary planes.
    public static func isPrivateUseCodepoint(_ value: UInt32) -> Bool {
        (value >= 0xE000 && value <= 0xF8FF) || (value >= 0xF_0000 && value <= 0xF_FFFD)
            || (value >= 0x10_0000 && value <= 0x10_FFFD)
    }

    /// Build a reader for `app`: compile-or-load the helper dylib under `cacheDir`, `dlopen` it, bind
    /// the entry points, and open the font. Returns nil (and `warn`s once with the reason) on any
    /// failure — the caller then stamps nothing and exits 0.
    public static func open(app: SfSymbolsApp, cacheDir: String, warn: ((String) -> Void)? = nil)
        -> SfSymbolCodepointReader?
    {
        guard let dylibPath = compileHelper(app: app, cacheDir: cacheDir, warn: warn) else { return nil }
        guard let handle = dlopen(dylibPath, RTLD_NOW | RTLD_LOCAL) else {
            warn?("codepoint helper dlopen failed: \(String(cString: dlerror()))")
            return nil
        }
        guard let openRaw = dlsym(handle, "adsym_open"), let lookupRaw = dlsym(handle, "adsym_lookup"),
            let closeRaw = dlsym(handle, "adsym_close")
        else {
            warn?("codepoint helper is missing an adsym_* entry point (symbol layout changed)")
            dlclose(handle)
            return nil
        }
        let openFn = unsafeBitCast(
            openRaw,
            to: (@convention(c) (UnsafePointer<CChar>?, UnsafePointer<CChar>?) -> UnsafeMutableRawPointer?).self)
        let lookupFn = unsafeBitCast(lookupRaw, to: LookupFn.self)
        let closeFn = unsafeBitCast(closeRaw, to: CloseFn.self)
        guard
            let readerHandle = app.fontPath.withCString({ fontC in
                app.metadataDir.withCString { metaC in openFn(fontC, metaC) }
            })
        else {
            // Reader init threw inside the framework — decrypt shape changed / font unreadable /
            // version unsupported. Degrade, don't crash (the JS `reader init failed` → exit 4).
            warn?("SF Symbols font reader init failed (decrypt shape or font unsupported)")
            dlclose(handle)
            return nil
        }
        return SfSymbolCodepointReader(
            dylibHandle: handle, readerHandle: readerHandle, lookupFn: lookupFn, closeFn: closeFn)
    }

    /// The symbol's Unicode codepoint, or nil when the font has no entry for `name` (the helper's
    /// sentinel 0, which is never a valid PUA value). PUA validation is the caller's (the JS keeps the
    /// non-PUA reject at the dump boundary).
    public func lookup(_ name: String) -> UInt32? {
        guard !closed else { return nil }
        let value = name.withCString { lookupFn(readerHandle, $0) }
        return value == 0 ? nil : value
    }

    /// Release the reader box + `dlclose` the dylib. Idempotent; also runs from `deinit`.
    public func close() {
        guard !closed else { return }
        closed = true
        closeFn(readerHandle)
        dlclose(dylibHandle)
    }
}

// MARK: - Helper dylib compile + cache

extension SfSymbolCodepointReader {
    /// `/usr/bin/swiftc` (the Xcode/toolchain shim). Absent → compile fails → graceful skip.
    private static let swiftcPath = "/usr/bin/swiftc"

    /// Return the path to a ready-to-`dlopen` helper dylib for `app`, compiling it into `cacheDir`
    /// on first use and reusing it thereafter. The cache filename embeds the app version, host arch,
    /// and a fingerprint of the exact source + shims, so an app upgrade or a source edit forces a
    /// rebuild while an unchanged tuple is a zero-cost cache hit. nil (with a `warn`) on any failure.
    static func compileHelper(app: SfSymbolsApp, cacheDir: String, warn: ((String) -> Void)?) -> String? {
        let major = app.major
        let triple = SfSymbolCodepointWorkerSource.moduleTriple
        let sharedInterface = SfSymbolCodepointWorkerSource.sfSymbolsSharedInterface(major: major)
        let glyphsInterface = SfSymbolCodepointWorkerSource.coreGlyphsLibInterface
        let helper = SfSymbolCodepointWorkerSource.helperSource(major: major)
        let fingerprint = String(
            Sha256.hexString([sharedInterface, glyphsInterface, helper, triple].joined(separator: "\u{1}"))
                .prefix(16))
        let versionTag = (app.version ?? "unknown").replacingOccurrences(of: "/", with: "_")
        let dylibPath = "\(cacheDir)/codepoint-helper-\(versionTag)-\(triple)-\(fingerprint).dylib"
        if FileManager.default.fileExists(atPath: dylibPath) { return dylibPath }

        guard FileManager.default.fileExists(atPath: swiftcPath) else {
            warn?("swiftc not found at \(swiftcPath); cannot build the SF Symbols codepoint helper")
            return nil
        }
        guard let stage = makeStageDir(warn: warn) else { return nil }
        defer { try? FileManager.default.removeItem(atPath: stage) }
        do {
            try writeShim(stage: stage, module: "SFSymbolsShared", triple: triple, interface: sharedInterface)
            try writeShim(stage: stage, module: "CoreGlyphsLib", triple: triple, interface: glyphsInterface)
            let source = "\(stage)/helper.swift"
            try helper.write(toFile: source, atomically: true, encoding: .utf8)
            let built = "\(stage)/libadsymcp.dylib"
            guard runSwiftc(app: app, stage: stage, source: source, output: built, warn: warn) else {
                return nil
            }
            try FileManager.default.createDirectory(atPath: cacheDir, withIntermediateDirectories: true)
            // Atomic publish: move into the cache under the content-addressed name. A racing builder
            // producing the identical file is harmless (same bytes); tolerate an already-present dest.
            try? FileManager.default.removeItem(atPath: dylibPath)
            try FileManager.default.moveItem(atPath: built, toPath: dylibPath)
            return dylibPath
        } catch {
            warn?("SF Symbols codepoint helper staging failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// Write one handcrafted `.swiftinterface` into `<stage>/<Module>.swiftmodule/<triple>.swiftinterface`
    /// — the layout `swiftc -I <stage>` resolves `import <Module>` from.
    private static func writeShim(stage: String, module: String, triple: String, interface: String) throws {
        let moduleDir = "\(stage)/\(module).swiftmodule"
        try FileManager.default.createDirectory(atPath: moduleDir, withIntermediateDirectories: true)
        try interface.write(toFile: "\(moduleDir)/\(triple).swiftinterface", atomically: true, encoding: .utf8)
    }

    /// Invoke `swiftc -emit-library` against the staged shims + the app's real frameworks, baking both
    /// framework dirs as absolute rpaths so the `dlopen`d dylib resolves `@rpath/SFSymbolsShared…` and
    /// `@rpath/CoreGlyphsLib…` at load time without any `DYLD_FRAMEWORK_PATH`. True on a clean build.
    private static func runSwiftc(
        app: SfSymbolsApp, stage: String, source: String, output: String, warn: ((String) -> Void)?
    ) -> Bool {
        let args = [
            "-emit-library", "-o", output,
            "-I", stage, "-F", app.sharedFrameworkDir, "-F", app.glyphsLibFrameworkDir,
            "-framework", "SFSymbolsShared", "-framework", "CoreGlyphsLib",
            "-Xlinker", "-rpath", "-Xlinker", app.sharedFrameworkDir,
            "-Xlinker", "-rpath", "-Xlinker", app.glyphsLibFrameworkDir,
            source
        ]
        let outcome = runProcess(swiftcPath, args, deadlineMs: 120_000)
        guard outcome.status == 0, FileManager.default.fileExists(atPath: output) else {
            let detail = outcome.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            warn?(
                "SF Symbols codepoint helper failed to compile (\(detail.isEmpty ? "status \(outcome.status)" : detail))"
            )
            return false
        }
        return true
    }

    /// A private, unguessable staging dir (`mkdtemp`, 0700 — the `FontSync.makeScratchDir` idiom).
    private static func makeStageDir(warn: ((String) -> Void)?) -> String? {
        let template = NSTemporaryDirectory() + "ad-cli-codepoint-helper-XXXXXX"
        var bytes = Array(template.utf8) + [0]
        let path = bytes.withUnsafeMutableBufferPointer { buffer -> String? in
            buffer.baseAddress.flatMap { mkdtemp($0) }.map { String(cString: $0) }
        }
        if path == nil { warn?("codepoint helper mkdtemp failed (errno \(errno))") }
        return path
    }
}

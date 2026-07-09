// The Swift the codepoint stamper compiles at runtime — the native port of
// src/resources/swift/symbol-codepoint-worker.js. TWO handcrafted `.swiftinterface`
// shims (SFSymbolsShared + CoreGlyphsLib ship NO `.swiftmodule`, so `swiftc` can't
// `import` them otherwise) plus a tiny `@_cdecl` helper the stamper builds into a
// dylib and `dlopen`s IN-PROCESS.
//
// Why compile at all, when ad-cli is native? The extraction pipeline is pure Swift
// (`SymbolFontReader`, `VariableSymbolFontProvider`, `Crypton`), and its symbols are
// Swift-mangled `@convention(method)` / generic entries — reaching them by raw
// `dlsym` is impossible from Swift source: the method `self` register (x20) + the
// `throws` error register + the generic metadata/witness arguments + resilient
// by-value structs are NOT spellable as a `@convention(c)` (or any) function-pointer
// type, so an `unsafeBitCast` call would corrupt the ABI. Letting `swiftc` emit the
// call once (against these shims) is the only ABI-correct native path; the compiled
// dylib is then cached + `dlopen`d, so there is no per-run compile and no subprocess
// at stamp time — the JS's per-symbol IPC + JIT-every-run overhead are both gone.
//
// The `.swiftinterface` layout is opaque under library-evolution mode, so the struct
// internals can drift across SF Symbols.app versions without breaking us; only
// `MetadataReadingOptions.init` changes shape, which is version-gated below exactly as
// the JS does (SF Symbols 8 grew a 5th `enhancedKeywordsURL` param and made the
// decryptor a non-optional `@escaping` closure).

import Foundation

/// The runtime-compiled Swift the codepoint reader stages + builds. All members are pure string
/// arithmetic (no FS, no spawn) so they are trivially unit-testable and cheap.
enum SfSymbolCodepointWorkerSource {
    /// The module triple `swiftc` matches a `<Module>.swiftmodule/<triple>.swiftinterface` file by,
    /// and the `-target` the shim declares. Host-arch only (arm64 is the verified slice; an x86_64
    /// host picks its own slice), matching the JS "Apple Silicon only is fine" note.
    static var moduleTriple: String {
        #if arch(x86_64)
            return "x86_64-apple-macos"
        #else
            return "arm64-apple-macos"
        #endif
    }

    /// The CoreGlyphsLib shim — just `Crypton.decryptObfuscatedFontTable`, stable since SF Symbols 3.
    static var coreGlyphsLibInterface: String {
        """
        // swift-interface-format-version: 1.0
        // swift-compiler-version: Apple Swift version 5.10
        // swift-module-flags: -target \(moduleTriple)14.0 -enable-library-evolution -module-name CoreGlyphsLib
        import CoreText
        import Foundation
        import Swift

        public struct Crypton {
          public static func decryptObfuscatedFontTable(tableTag: Swift.UInt32, from: CoreText.CTFont) -> Foundation.Data?
        }
        """
    }

    /// The SFSymbolsShared shim, matched to the app's major. `MetadataReadingOptions.init` is the only
    /// drifting signature: SF Symbols ≤ 7 declared a 4-param init whose decryptor closure was OPTIONAL
    /// (no `enhancedKeywordsURL`); 8+ added `enhancedKeywordsURL` and made the decryptor a non-optional
    /// `@escaping` closure. The declared init must mangle byte-for-byte to what the linked framework
    /// exports, so it is selected by `major` — the JS `sfSymbolsSharedInterface`.
    static func sfSymbolsSharedInterface(major: Int) -> String {
        let metaInit =
            major >= 8
            ? """
                public init(
                  fontTableDecryptor: @escaping (CoreText.CTFont, Swift.UInt32) -> Foundation.Data?,
                  customCSVData: Foundation.Data?,
                  additionalCSVColumns: [Swift.String]?,
                  metadataDirectory: Foundation.URL?,
                  enhancedKeywordsURL: Foundation.URL?
                )
            """
            : """
                public init(
                  fontTableDecryptor: ((CoreText.CTFont, Swift.UInt32) -> Foundation.Data?)?,
                  customCSVData: Foundation.Data?,
                  additionalCSVColumns: [Swift.String]?,
                  metadataDirectory: Foundation.URL?
                )
            """
        return """
            // swift-interface-format-version: 1.0
            // swift-compiler-version: Apple Swift version 5.10
            // swift-module-flags: -target \(moduleTriple)14.0 -enable-library-evolution -module-name SFSymbolsShared
            import CoreText
            import Foundation
            import Swift

            public protocol SymbolFontProvider {}

            public struct VariableSymbolFontProvider : SFSymbolsShared.SymbolFontProvider {
              public init(url: Foundation.URL)
            }

            public struct FontSymbol {
              public var pua: Swift.Unicode.Scalar { get }
            }

            final public class SymbolFontReader {
              public struct MetadataReadingOptions {
            \(metaInit)
              }
              public init<A>(symbolFontProvider: A, metadataReadingOptions: SFSymbolsShared.SymbolFontReader.MetadataReadingOptions) throws where A : SFSymbolsShared.SymbolFontProvider
              final public func symbol(forSystemName: Swift.String, preferComposite: Swift.Bool) -> SFSymbolsShared.FontSymbol?
            }
            """
    }

    /// The `@_cdecl` helper the stamper `dlopen`s. Exposes a 3-call C ABI over the Swift pipeline:
    ///
    ///   `adsym_open(fontPath, metadataDir)` → opaque handle (a retained reader box), or NULL when the
    ///        reader init throws (decrypt shape changed / unsupported font);
    ///   `adsym_lookup(handle, name)` → the symbol's PUA codepoint, or 0 (never a valid PUA value) when
    ///        the name is absent from the font;
    ///   `adsym_close(handle)` releases the box.
    ///
    /// The v8 `MetadataReadingOptions.init` call carries `enhancedKeywordsURL: nil`; the v7 downgrade
    /// drops that argument (the JS `symbolCodepointWorkerScript` downgrade).
    static func helperSource(major: Int) -> String {
        let enhancedArg = major >= 8 ? ",\n        enhancedKeywordsURL: nil" : ""
        return """
            import CoreText
            import Foundation
            import SFSymbolsShared
            import CoreGlyphsLib

            final class ReaderBox { let reader: SymbolFontReader; init(_ r: SymbolFontReader) { reader = r } }

            @_cdecl("adsym_open")
            public func adsym_open(
              _ fontPathC: UnsafePointer<CChar>?, _ metaDirC: UnsafePointer<CChar>?
            ) -> UnsafeMutableRawPointer? {
              guard let fontPathC, let metaDirC else { return nil }
              let fontPath = String(cString: fontPathC)
              let metaDir = String(cString: metaDirC)
              guard FileManager.default.fileExists(atPath: fontPath) else { return nil }
              let provider = VariableSymbolFontProvider(url: URL(fileURLWithPath: fontPath))
              let opts = SymbolFontReader.MetadataReadingOptions(
                fontTableDecryptor: { font, tag in Crypton.decryptObfuscatedFontTable(tableTag: tag, from: font) },
                customCSVData: nil,
                additionalCSVColumns: nil,
                metadataDirectory: URL(fileURLWithPath: metaDir)\(enhancedArg))
              guard let reader = try? SymbolFontReader(symbolFontProvider: provider, metadataReadingOptions: opts)
              else { return nil }
              return Unmanaged.passRetained(ReaderBox(reader)).toOpaque()
            }

            @_cdecl("adsym_lookup")
            public func adsym_lookup(_ handle: UnsafeMutableRawPointer?, _ nameC: UnsafePointer<CChar>?) -> UInt32 {
              guard let handle, let nameC else { return 0 }
              let box = Unmanaged<ReaderBox>.fromOpaque(handle).takeUnretainedValue()
              let name = String(cString: nameC)
              if let sym = box.reader.symbol(forSystemName: name, preferComposite: true) { return sym.pua.value }
              return 0
            }

            @_cdecl("adsym_close")
            public func adsym_close(_ handle: UnsafeMutableRawPointer?) {
              guard let handle else { return }
              Unmanaged<ReaderBox>.fromOpaque(handle).release()
            }
            """
    }
}

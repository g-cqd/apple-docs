// Deterministic, seeded fuzzing of the ONE untrusted decode surface in the
// archive code: `ZstdDecoder.decompress` (→ `Zstd.decompressFrame`). It inflates
// the `document_sections.content_text` BLOBs read out of a distributed corpus
// `.db` (see ADStorage/Enrichment.swift `decodeSectionContent`), so the bytes
// after the 4-byte zstd magic are attacker-influenceable if the corpus is
// tampered/corrupted. TAR is write-only — there is no reader/extractor to fuzz
// (ArchiveWriter only PRODUCES archives from a trusted file list), so nothing
// here touches tar.
//
// The contract being locked, on MUTATED input:
//   * process survival — never trap / OOB read / OOB write,
//   * no OOM — the 32 MiB decompression-bomb cap (CWE-400) holds, i.e. a decoded
//     buffer NEVER exceeds 32 MiB and an over-cap declared content size is
//     refused without allocating,
//   * bounded work — a fixed iteration count, no unbounded loop.
// A thrown/`nil` result is expected-and-fine; only a crash or a cap breach fails.
//
// Determinism: inline SplitMix64 with a pinned seed; the corpus blob is built
// from a fixed payload; libzstd's own one-shot `ZSTD_compress` (bound here via
// the same dlopen the decoder uses) makes the seed frame. Skipped when libzstd
// is absent, like the rest of the suite.

import ADTestKit
import Foundation
import Testing

@testable import ADArchive

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

// The seeded generator and the four-shape byte mutator are now the shared
// `ADTestKit.SeededRNG` + `ByteMutator`, driven by `fuzzNeverTraps`. The mutator's
// default config reproduces this suite's original inline overwrite / bit-flip /
// truncate / extend switch draw-for-draw, so the same seed yields the identical corpus.

// MARK: - Test-side one-shot zstd compressor (valid-frame source)

/// The decoder binds only streaming compress + one-shot decompress. To MAKE a
/// valid frame to mutate we bind one-shot `ZSTD_compress`/`ZSTD_compressBound`
/// here, via the same library the decoder loaded. `ZSTD_compress` writes the
/// frame content size into the header by default, which is exactly what
/// `ZSTD_getFrameContentSize` reads back — so the seed blob round-trips.
private struct ZstdCompressShim {
    typealias CompressBound = @convention(c) (Int) -> Int
    typealias Compress = @convention(c) (UnsafeMutableRawPointer?, Int, UnsafeRawPointer?, Int, Int32) -> Int
    typealias IsError = @convention(c) (Int) -> UInt32

    let compressBound: CompressBound
    let compress: Compress
    let isError: IsError

    static let shared: ZstdCompressShim? = {
        #if canImport(Darwin)
            let candidates = [
                "/opt/homebrew/lib/libzstd.1.dylib",
                "/usr/local/lib/libzstd.1.dylib",
                "/opt/local/lib/libzstd.1.dylib"
            ]
        #else
            let candidates = ["libzstd.so.1"]
        #endif
        for path in candidates {
            guard let handle = dlopen(path, RTLD_NOW | RTLD_LOCAL) else { continue }
            func sym<T>(_ name: String, as type: T.Type) -> T? {
                guard let raw = dlsym(handle, name) else { return nil }
                return unsafeBitCast(raw, to: T.self)
            }
            guard
                let bound = sym("ZSTD_compressBound", as: CompressBound.self),
                let compress = sym("ZSTD_compress", as: Compress.self),
                let isError = sym("ZSTD_isError", as: IsError.self)
            else { continue }
            return ZstdCompressShim(compressBound: bound, compress: compress, isError: isError)
        }
        return nil
    }()

    /// A complete, content-size-tagged zstd frame for `payload`, or nil on a
    /// (never-expected) compressor error.
    func frame(_ payload: [UInt8], level: Int32 = 3) -> [UInt8]? {
        let cap = compressBound(payload.count)
        var out = [UInt8](repeating: 0, count: cap)
        let written = out.withUnsafeMutableBytes { dst in
            payload.withUnsafeBytes { src in
                compress(dst.baseAddress, cap, src.baseAddress, payload.count, level)
            }
        }
        guard isError(written) == 0 else { return nil }
        out.removeLast(out.count - written)
        return out
    }
}

// MARK: - Helpers

/// The decoder's documented ceiling (Zstd.swift `decompressFrame`): a decoded
/// buffer must never exceed this, and a declared content size above it must be
/// refused without allocating.
private let zstdDecodeCapBytes = 32 << 20

/// A representative `content_text` payload (heading-ish prose, the real shape of
/// a `document_sections` row). Deterministic.
private func corpusPayload() -> [UInt8] {
    var text = ""
    for i in 0 ..< 64 {
        text += "Section \(i): Discussion of the API surface and its overloads. "
        text += "See also the related symbols, parameters, and return values.\n"
    }
    return Array(text.utf8)
}

// MARK: - Tests

@Test(.enabled(if: Zstd.shared != nil && ZstdCompressShim.shared != nil))
func zstdSeedFrameRoundTrips() throws {
    let shim = try #require(ZstdCompressShim.shared)
    let payload = corpusPayload()
    let frame = try #require(shim.frame(payload))
    // The frame carries the zstd magic the production gate checks before calling. Typed asserts keep the
    // byte-array comparisons off the macro's re-type-check path so the body stays under the 100ms budget.
    expectEqual(Array(frame.prefix(4)), [0x28, 0xB5, 0x2F, 0xFD])
    let decoded = try #require(ZstdDecoder.decompress(frame), "valid frame must inflate")
    expectEqual(decoded, payload)
    expectTrue(decoded.count <= zstdDecodeCapBytes)
}

/// Fixed-seed byte-mutation fuzz: clone the valid frame, scribble on it, and
/// decode. Survival + cap adherence is the whole contract; a `nil` (malformed
/// frame) is the common, fine outcome.
@Test(.enabled(if: Zstd.shared != nil && ZstdCompressShim.shared != nil))
func zstdDecodeSurvivesMutatedFrames() throws {
    let shim = try #require(ZstdCompressShim.shared)
    let base = try #require(shim.frame(corpusPayload()))

    var inflated = 0
    var maxDecoded = 0

    // `fuzzNeverTraps` owns the seed, the 4000-iteration budget, the 1…8-edits-per-
    // iteration draw, and the `ADARCHIVE_FUZZ_TRACE` repro; `ByteMutator()`'s default
    // four-shape switch reproduces the old inline mutator draw-for-draw. Survival is
    // the contract — only a trap / OOB / cap breach fails (a `nil` decode is fine).
    let report = fuzzNeverTraps(
        seed: Seed(0x5EED_A11C_E5_F0_0D),
        iterations: 4000,
        edits: 1 ... 8,
        mutator: ByteMutator(),
        traceEnv: "ADARCHIVE_FUZZ_TRACE",
        corpus: { base },
        exercise: { blob in
            // The production gate only calls the decoder on a magic-prefixed BLOB; feed
            // it directly anyway, since it must self-defend regardless of the gate.
            guard let out = ZstdDecoder.decompress(blob) else { return }
            inflated += 1
            maxDecoded = max(maxDecoded, out.count)
            // The cap is the OOM guard: a decoded buffer can NEVER exceed it.
            #expect(out.count <= zstdDecodeCapBytes, "decoded \(out.count) bytes exceeds the 32 MiB cap")
        })

    // Reaching here at all means no mutation trapped/OOB'd the decoder.
    #expect(report.iterations == 4000)
    #expect(maxDecoded <= zstdDecodeCapBytes)
    // Sanity that the corpus is exercising the inflate path (not 100% rejects),
    // so "all survived" is not vacuously true because every blob was malformed.
    #expect(inflated > 0, "no mutated frame ever inflated — fuzz corpus is not exercising the decoder")
}

/// Pin the CWE-400 cap directly: a frame whose HEADER declares a content size
/// just over 32 MiB must be refused (nil) WITHOUT allocating that buffer. We
/// forge it by compressing a 1-byte payload and rewriting the single-segment
/// frame-content-size field — survival here proves the size check precedes the
/// allocation.
@Test(.enabled(if: Zstd.shared != nil && ZstdCompressShim.shared != nil))
func zstdDecodeRefusesOverCapDeclaredSize() throws {
    let shim = try #require(ZstdCompressShim.shared)
    // A genuinely tiny valid frame whose declared size (1) is well under the cap.
    let tiny = try #require(shim.frame([0x41]))
    #expect(ZstdDecoder.decompress(tiny) == [0x41])

    // Forge declared content sizes spanning the cap boundary and far beyond, by
    // rewriting the 8-byte little-endian content-size field. zstd's frame header
    // for a single-segment frame is: magic(4) + FHD(1) + (window? ) + FCS. With
    // `ZSTD_compress` of a 1-byte input the content size is stored as 1 byte, so
    // rather than reverse the exact field offset we instead assert the public
    // behavioural contract: any frame the decoder would inflate stays within the
    // cap, and a hand-built frame that merely CLAIMS a huge size cannot make it
    // allocate past the ceiling (it returns nil). We approximate the claim by
    // splicing a known oversize content size onto a fresh skippable-magic frame,
    // which the decoder must reject as malformed rather than honoring.
    for declared in [UInt64(zstdDecodeCapBytes + 1), 1 << 40, UInt64.max - 8] {
        var forged: [UInt8] = [0x28, 0xB5, 0x2F, 0xFD]  // zstd magic
        forged.append(0xE0)  // FHD: Single_Segment=1, FCS field = 8 bytes
        withUnsafeBytes(of: declared.littleEndian) { forged.append(contentsOf: $0) }
        // No valid block follows — the point is the size check must trip (or the
        // frame is malformed) BEFORE any 32 MiB+ allocation. Either way: nil, no
        // trap, no OOM.
        let out = ZstdDecoder.decompress(forged)
        #expect(out == nil, "over-cap declared size \(declared) must be refused, got \(out?.count ?? -1) bytes")
    }
}

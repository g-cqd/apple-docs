internal import CAppleDocsKernels

extension AppleDocsKernels {
    // MARK: - 4. Sign-bit & int8 quantization

    private typealias FloatToByteCFunction =
        @convention(c) (UnsafePointer<Float>?, Int, UnsafeMutablePointer<UInt8>?) -> Void

    private struct FloatToByteKernels {
        let fastest: FloatToByteCFunction
        let scalar: FloatToByteCFunction
        let sse2: FloatToByteCFunction
        let avx2: FloatToByteCFunction
        let neon: FloatToByteCFunction

        func select(_ backend: Backend) -> FloatToByteCFunction {
            switch backend {
                case .fastest: fastest
                case .scalar: scalar
                case .sse2, .sse42: sse2
                case .avx2: avx2
                case .neon: neon
            }
        }
    }

    private static let signBitKernels = FloatToByteKernels(
        fastest: adk_quantize_sign_bits,
        scalar: adk_quantize_sign_bits_scalar,
        sse2: adk_quantize_sign_bits_sse2,
        avx2: adk_quantize_sign_bits_avx2,
        neon: adk_quantize_sign_bits_neon
    )

    private static let int8Kernels = FloatToByteKernels(
        fastest: adk_quantize_i8,
        scalar: adk_quantize_i8_scalar,
        sse2: adk_quantize_i8_sse2,
        avx2: adk_quantize_i8_avx2,
        neon: adk_quantize_i8_neon
    )

    /// Packs sign bits of `vector[0..<dimensions]` (`bit (i & 7)` of byte `i >> 3` is `1` iff `vector[i] >= 0`).
    public static func quantizeSignBits(
        _ vector: [Float],
        dimensions: Int? = nil,
        backend: Backend = .fastest
    ) -> [UInt8] {
        let dims = min(vector.count, dimensions ?? vector.count)
        let byteLen = (max(0, dimensions ?? vector.count) + 7) >> 3
        guard byteLen > 0 else { return [] }
        guard dims > 0 else { return [UInt8](repeating: 0, count: byteLen) }
        return runFloatToByteKernel(
            vector: vector,
            inputCount: dims,
            outputCount: byteLen,
            kernel: signBitKernels.select(backend)
        )
    }

    /// Quantizes `vector` into `vector.count` signed int8 bytes (JS `Math.round` tie-breaking) + 4-byte LE scale.
    public static func quantizeInt8(_ vector: [Float], backend: Backend = .fastest) -> [UInt8] {
        let dims = vector.count
        guard dims > 0 else {
            let bits = Float(1.0).bitPattern
            return [
                UInt8(truncatingIfNeeded: bits),
                UInt8(truncatingIfNeeded: bits >> 8),
                UInt8(truncatingIfNeeded: bits >> 16),
                UInt8(truncatingIfNeeded: bits >> 24)
            ]
        }
        return runFloatToByteKernel(
            vector: vector,
            inputCount: dims,
            outputCount: dims + 4,
            kernel: int8Kernels.select(backend)
        )
    }

    private static func runFloatToByteKernel(
        vector: [Float],
        inputCount: Int,
        outputCount: Int,
        kernel: FloatToByteCFunction
    ) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: outputCount)
        vector.withUnsafeBufferPointer { vBuf in
            out.withUnsafeMutableBufferPointer { oBuf in
                guard let vBase = vBuf.baseAddress, let oBase = oBuf.baseAddress else { return }
                unsafe kernel(vBase, inputCount, oBase)
            }
        }
        return out
    }

    // MARK: - 5. Myers 64-bit bit-parallel UTF-16 Levenshtein

    /// Bounded edit distance over UTF-16 slices (`<= maxDistance` exact, else `maxDistance + 1`).
    public static func levenshteinUTF16(
        _ lhs: [UInt16],
        _ rhs: [UInt16],
        maxDistance: Int
    ) -> Int {
        guard maxDistance >= 0 else { return 1 }
        if lhs.isEmpty { return rhs.count <= maxDistance ? rhs.count : maxDistance + 1 }
        if rhs.isEmpty { return lhs.count <= maxDistance ? lhs.count : maxDistance + 1 }
        let clampedMax = Int32(min(maxDistance, Int(Int32.max - 2)))
        return lhs.withUnsafeBufferPointer { lBuf in
            rhs.withUnsafeBufferPointer { rBuf in
                guard let lBase = lBuf.baseAddress, let rBase = rBuf.baseAddress else { return maxDistance + 1 }
                return Int(unsafe adk_levenshtein_u16(lBase, lhs.count, rBase, rhs.count, clampedMax))
            }
        }
    }
}

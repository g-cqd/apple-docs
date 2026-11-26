import AppleDocsKernels

/// Vector quantization matching Bun's `search/semantic.js` (`quantizeTo` + `quantizeI8`), dispatched
/// through `AppleDocsKernels` SIMD backends (NEON / AVX2 / SSE2 / scalar).
public enum EmbeddingQuantizer {
    /// Sign bits packed LSB-first: bit `i & 7` of byte `i >> 3` is `1` when `vector[i] >= 0`.
    public static func signBits(_ vector: [Float]) -> [UInt8] {
        AppleDocsKernels.quantizeSignBits(vector)
    }

    /// Symmetric int8 quantization with trailing little-endian float32 scale (`vector.count + 4` bytes).
    public static func int8(_ vector: [Float]) -> [UInt8] {
        AppleDocsKernels.quantizeInt8(vector)
    }
}

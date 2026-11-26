//
//  AppleDocsKernels.swift
//  AppleDocsKernels
//
//  Pure-Swift SE-0458 strict-memory-safe facade over `CAppleDocsKernels` (modeled on `AemiKernels`):
//  runtime-dispatched NEON / AVX2+FMA / SSE4.2 / SSE2 / scalar kernels for Hamming distance batches,
//  int8 dot-product rescoring, Model2Vec Q8 gather/pool/L2-normalize, sign-bit & int8 quantization,
//  and Myers 64-bit bit-parallel UTF-16 Levenshtein.
//

internal import CAppleDocsKernels

/// Runtime-dispatched SIMD kernels used across `AppleDocsSearch` and `AppleDocsPipeline`.
public enum AppleDocsKernels: Sendable {
    /// Target backend selector; every backend self-guards and produces identical results.
    public enum Backend: Sendable, CaseIterable {
        case fastest
        case scalar
        case sse2
        case sse42
        case avx2
        case neon
    }

    /// Name of the active runtime SIMD backend (`"neon"`, `"avx2"`, `"sse4.2"`, `"sse2"`, `"scalar"`).
    public static var activeBackend: String {
        unsafe String(cString: adk_backend())
    }

    // MARK: - 1. Batch Hamming distances

    /// Writes `rowCount` Hamming distances into `outDistances[0..<rowCount]` comparing `query[0..<byteWidth]`
    /// against `packed[0 ..< rowCount * byteWidth]`.
    public static func hammingBatch(
        query: UnsafePointer<UInt8>,
        packed: UnsafePointer<UInt8>,
        rowCount: Int,
        byteWidth: Int,
        into outDistances: UnsafeMutablePointer<UInt16>,
        backend: Backend = .fastest
    ) {
        guard rowCount > 0, byteWidth > 0 else { return }
        switch backend {
            case .fastest: unsafe adk_hamming_batch(query, packed, rowCount, byteWidth, outDistances)
            case .scalar: unsafe adk_hamming_batch_scalar(query, packed, rowCount, byteWidth, outDistances)
            case .sse2: unsafe adk_hamming_batch_sse2(query, packed, rowCount, byteWidth, outDistances)
            case .sse42: unsafe adk_hamming_batch_sse42(query, packed, rowCount, byteWidth, outDistances)
            case .avx2: unsafe adk_hamming_batch_avx2(query, packed, rowCount, byteWidth, outDistances)
            case .neon: unsafe adk_hamming_batch_neon(query, packed, rowCount, byteWidth, outDistances)
        }
    }

    /// Safe array wrapper for ``hammingBatch(query:packed:rowCount:byteWidth:into:backend:)`` (differential tests).
    public static func hammingDistances(
        query: [UInt8],
        packed: [UInt8],
        byteWidth: Int,
        backend: Backend = .fastest
    ) -> [UInt16] {
        guard byteWidth > 0, query.count >= byteWidth else { return [] }
        let rowCount = packed.count / byteWidth
        guard rowCount > 0 else { return [] }
        var out = [UInt16](repeating: 0, count: rowCount)
        query.withUnsafeBufferPointer { qBuf in
            packed.withUnsafeBufferPointer { pBuf in
                out.withUnsafeMutableBufferPointer { oBuf in
                    guard let qBase = qBuf.baseAddress, let pBase = pBuf.baseAddress, let oBase = oBuf.baseAddress
                    else { return }
                    unsafe hammingBatch(
                        query: qBase,
                        packed: pBase,
                        rowCount: rowCount,
                        byteWidth: byteWidth,
                        into: oBase,
                        backend: backend
                    )
                }
            }
        }
        return out
    }

    // MARK: - 2. Int8 dot-product rescoring

    /// Computes `(Σ_d Double(query[d]) * Double(Int8(bitPattern: packedPayload[d]))) * Double(scale)`.
    public static func dotInt8(
        query: [Float],
        packedPayload: [UInt8],
        dimensions: Int,
        backend: Backend = .fastest
    ) -> Double {
        guard dimensions > 0, query.count >= dimensions, packedPayload.count >= dimensions + 4 else { return 0 }
        let scaleBits =
            UInt32(packedPayload[dimensions])
            | (UInt32(packedPayload[dimensions + 1]) << 8)
            | (UInt32(packedPayload[dimensions + 2]) << 16)
            | (UInt32(packedPayload[dimensions + 3]) << 24)
        let scale = Float(bitPattern: scaleBits)
        return query.withUnsafeBufferPointer { qBuf in
            packedPayload.withUnsafeBufferPointer { pBuf in
                guard let qBase = qBuf.baseAddress, let pBase = pBuf.baseAddress else { return 0 }
                let i8Ptr = unsafe UnsafeRawPointer(pBase).assumingMemoryBound(to: Int8.self)
                switch backend {
                    case .fastest: return unsafe adk_dot_f32_i8(qBase, i8Ptr, dimensions, scale)
                    case .scalar: return unsafe adk_dot_f32_i8_scalar(qBase, i8Ptr, dimensions, scale)
                    case .sse2, .sse42: return unsafe adk_dot_f32_i8_sse2(qBase, i8Ptr, dimensions, scale)
                    case .avx2: return unsafe adk_dot_f32_i8_avx2(qBase, i8Ptr, dimensions, scale)
                    case .neon: return unsafe adk_dot_f32_i8_neon(qBase, i8Ptr, dimensions, scale)
                }
            }
        }
    }

    // MARK: - 3. Model2Vec Q8 gather + mean-pool + L2-normalize

    /// Gathers `tokenIDs` from `q8Bytes[dataOffset ..< dataOffset + rows * dims]` + `scales[0..<rows]`,
    /// mean-pools in `Double`, converts to `Float`, and L2-normalizes to unit length.
    public static func poolQ8AndNormalize(
        tokenIDs: [Int32],
        q8Bytes: [UInt8],
        dataOffset: Int,
        scales: [Float],
        rows: Int,
        dimensions: Int,
        backend: Backend = .fastest
    ) -> [Float] {
        guard rows > 0, dimensions > 0, !tokenIDs.isEmpty,
            scales.count >= rows, dataOffset >= 0, q8Bytes.count >= dataOffset + rows * dimensions
        else { return [] }
        var out = [Float](repeating: 0, count: dimensions)
        tokenIDs.withUnsafeBufferPointer { idBuf in
            q8Bytes.withUnsafeBufferPointer { qBuf in
                scales.withUnsafeBufferPointer { sBuf in
                    out.withUnsafeMutableBufferPointer { oBuf in
                        guard let idBase = idBuf.baseAddress,
                            let qBase = qBuf.baseAddress,
                            let sBase = sBuf.baseAddress,
                            let oBase = oBuf.baseAddress
                        else { return }
                        let i8Base = unsafe UnsafeRawPointer(qBase + dataOffset).assumingMemoryBound(to: Int8.self)
                        unsafe dispatchPoolQ8(
                            idBase: idBase,
                            idCount: tokenIDs.count,
                            i8Base: i8Base,
                            scales: sBase,
                            rows: rows,
                            dims: dimensions,
                            out: oBase,
                            backend: backend
                        )
                    }
                }
            }
        }
        return out
    }

    // swiftlint:disable:next function_parameter_count
    private static func dispatchPoolQ8(
        idBase: UnsafePointer<Int32>,
        idCount: Int,
        i8Base: UnsafePointer<Int8>,
        scales: UnsafePointer<Float>,
        rows: Int,
        dims: Int,
        out: UnsafeMutablePointer<Float>,
        backend: Backend
    ) {
        switch backend {
            case .fastest: unsafe adk_q8_pool_l2(idBase, idCount, i8Base, scales, rows, dims, out)
            case .scalar: unsafe adk_q8_pool_l2_scalar(idBase, idCount, i8Base, scales, rows, dims, out)
            case .sse2, .sse42: unsafe adk_q8_pool_l2_sse2(idBase, idCount, i8Base, scales, rows, dims, out)
            case .avx2: unsafe adk_q8_pool_l2_avx2(idBase, idCount, i8Base, scales, rows, dims, out)
            case .neon: unsafe adk_q8_pool_l2_neon(idBase, idCount, i8Base, scales, rows, dims, out)
        }
    }
}

import AppleDocsKernels
import Testing

@Suite("AppleDocsKernels — cross-ISA differential parity against scalar oracle")
struct AppleDocsKernelsTests {
    @Test func `Hamming batch and Myers Levenshtein match scalar reference across widths and lengths`() {
        #expect(!AppleDocsKernels.activeBackend.isEmpty)
        for width in [64, 32, 47] {
            let query = (0 ..< width).map { UInt8(truncatingIfNeeded: $0 &* 37 &+ 11) }
            let packed = (0 ..< 91 * width).map { UInt8(truncatingIfNeeded: $0 &* 13 &+ 5) }
            let ref = AppleDocsKernels.hammingDistances(
                query: query,
                packed: packed,
                byteWidth: width,
                backend: .scalar
            )
            for backend in AppleDocsKernels.Backend.allCases {
                #expect(
                    AppleDocsKernels.hammingDistances(query: query, packed: packed, byteWidth: width, backend: backend)
                        == ref
                )
            }
        }
        #expect(
            AppleDocsKernels.levenshteinUTF16(
                Array("navigationstack".utf16),
                Array("navigatonstak".utf16),
                maxDistance: 3
            ) == 2
        )
        #expect(
            AppleDocsKernels.levenshteinUTF16(
                Array("navigationstack".utf16),
                Array("uicollectionview".utf16),
                maxDistance: 2
            ) > 2
        )
        let longA = Array(String(repeating: "abcdefghij", count: 8).utf16)
        let longB = Array((String(repeating: "abcdefghij", count: 7) + "abcdefghik").utf16)
        #expect(AppleDocsKernels.levenshteinUTF16(longA, longB, maxDistance: 2) == 1)
    }

    @Test func `quantizeSignBits, quantizeInt8, dotInt8, and poolQ8AndNormalize match scalar across backends`() {
        for dims in [512, 256, 37] {
            var vec = (0 ..< dims).map { Float(($0 % 23) - 11) * 0.0625 }
            vec[0] = 0.0
            vec[1] = -0.0
            let signRef = AppleDocsKernels.quantizeSignBits(vec, backend: .scalar)
            let i8Ref = AppleDocsKernels.quantizeInt8(vec, backend: .scalar)
            let dotRef = AppleDocsKernels.dotInt8(query: vec, packedPayload: i8Ref, dimensions: dims, backend: .scalar)
            for backend in AppleDocsKernels.Backend.allCases {
                #expect(AppleDocsKernels.quantizeSignBits(vec, backend: backend) == signRef)
                #expect(AppleDocsKernels.quantizeInt8(vec, backend: backend) == i8Ref)
                let d = AppleDocsKernels.dotInt8(query: vec, packedPayload: i8Ref, dimensions: dims, backend: backend)
                #expect(abs(d - dotRef) <= 1e-11 * max(1.0, abs(dotRef)))
            }
        }

        let q8Bytes = (0 ..< 15 + 32 * 512).map { UInt8(truncatingIfNeeded: $0 &* 29 &+ 3) }
        let scales = (0 ..< 32).map { Float($0 + 1) * 0.0025 }
        let ids: [Int32] = [0, 4, 15, 31, -2, 100, 7]
        let poolRef = AppleDocsKernels.poolQ8AndNormalize(
            tokenIDs: ids,
            q8Bytes: q8Bytes,
            dataOffset: 15,
            scales: scales,
            rows: 32,
            dimensions: 512,
            backend: .scalar
        )
        for backend in AppleDocsKernels.Backend.allCases {
            #expect(
                AppleDocsKernels.poolQ8AndNormalize(
                    tokenIDs: ids,
                    q8Bytes: q8Bytes,
                    dataOffset: 15,
                    scales: scales,
                    rows: 32,
                    dimensions: 512,
                    backend: backend
                ) == poolRef
            )
        }
    }
}

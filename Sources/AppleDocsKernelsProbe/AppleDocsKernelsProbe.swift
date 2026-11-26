//
//  AppleDocsKernelsProbe.swift
//  AppleDocsKernelsProbe
//
//  Standalone differential + throughput probe for `AppleDocsKernels` across every compiled ISA tier
//  (`scalar`, `sse2`, `sse42`, `avx2`, `neon`, `fastest`), modeled on `AemiKernelsProbe`.
//

import AppleDocsKernels
import Foundation

@main
enum AppleDocsKernelsProbe {
    struct XorShift64 {
        var state: UInt64
        mutating func next() -> UInt64 {
            state ^= state << 13
            state ^= state >> 7
            state ^= state << 17
            return state
        }
        mutating func byte() -> UInt8 { UInt8(truncatingIfNeeded: next()) }
        mutating func unitFloat() -> Float {
            Float(Int32(bitPattern: UInt32(truncatingIfNeeded: next()))) / Float(Int32.max)
        }
    }

    static func main() {
        var rng = XorShift64(state: 0xC0FFEE_1234_5678)
        verifyHamming(&rng)
        verifyDotAndQuantize(&rng)
        verifyQ8Pool(&rng)
        verifyLevenshtein()
        print("AppleDocsKernelsProbe OK (activeBackend=\(AppleDocsKernels.activeBackend))")
        if CommandLine.arguments.contains("--bench") {
            runBench()
        }
    }

    static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }

    static func referenceLevenshtein(_ a: [UInt16], _ b: [UInt16], maxDist: Int) -> Int {
        if abs(a.count - b.count) > maxDist { return maxDist + 1 }
        if a.isEmpty { return b.count <= maxDist ? b.count : maxDist + 1 }
        if b.isEmpty { return a.count <= maxDist ? a.count : maxDist + 1 }
        var prev = Array(0 ... b.count)
        var curr = [Int](repeating: 0, count: b.count + 1)
        for i in 1 ... a.count {
            curr[0] = i
            var rowMin = i
            for j in 1 ... b.count {
                let cost = a[i - 1] == b[j - 1] ? prev[j - 1] : prev[j - 1] + 1
                curr[j] = min(cost, min(prev[j] + 1, curr[j - 1] + 1))
                if curr[j] < rowMin { rowMin = curr[j] }
            }
            if rowMin > maxDist { return maxDist + 1 }
            swap(&prev, &curr)
        }
        return prev[b.count] <= maxDist ? prev[b.count] : maxDist + 1
    }

    private static func verifyHamming(_ rng: inout XorShift64) {
        for width in [64, 32, 47, 7] {
            let query = (0 ..< width).map { _ in rng.byte() }
            let packed = (0 ..< 137 * width).map { _ in rng.byte() }
            let expected = AppleDocsKernels.hammingDistances(
                query: query,
                packed: packed,
                byteWidth: width,
                backend: .scalar
            )
            for backend in AppleDocsKernels.Backend.allCases
            where AppleDocsKernels.hammingDistances(query: query, packed: packed, byteWidth: width, backend: backend)
                != expected
            {
                fail("hamming mismatch width=\(width) backend=\(backend)")
            }
        }
    }

    private static func verifyDotAndQuantize(_ rng: inout XorShift64) {
        for dims in [512, 256, 37, 1] {
            var query = (0 ..< dims).map { _ in rng.unitFloat() }
            query[0] = 0.0
            if dims > 1 { query[1] = -0.0 }
            let signRef = AppleDocsKernels.quantizeSignBits(query, backend: .scalar)
            let i8Ref = AppleDocsKernels.quantizeInt8(query, backend: .scalar)
            let dotRef = AppleDocsKernels.dotInt8(
                query: query,
                packedPayload: i8Ref,
                dimensions: dims,
                backend: .scalar
            )
            for backend in AppleDocsKernels.Backend.allCases {
                if AppleDocsKernels.quantizeSignBits(query, backend: backend) != signRef {
                    fail("quantizeSignBits mismatch dims=\(dims) backend=\(backend)")
                }
                if AppleDocsKernels.quantizeInt8(query, backend: backend) != i8Ref {
                    fail("quantizeInt8 mismatch dims=\(dims) backend=\(backend)")
                }
                let d = AppleDocsKernels.dotInt8(query: query, packedPayload: i8Ref, dimensions: dims, backend: backend)
                if abs(d - dotRef) > 1e-11 * max(1.0, abs(dotRef)) {
                    fail("dotInt8 mismatch dims=\(dims) backend=\(backend): \(d) vs \(dotRef)")
                }
            }
        }
    }

    private static func verifyQ8Pool(_ rng: inout XorShift64) {
        for dims in [512, 37] {
            let rows = 64
            let q8Bytes = (0 ..< 15 + rows * dims).map { _ in rng.byte() }
            let scales = (0 ..< rows).map { _ in abs(rng.unitFloat()) * 0.05 + 1e-4 }
            let ids: [Int32] = [0, 3, 17, 63, -1, 999, 12, 5, 3]
            let ref = AppleDocsKernels.poolQ8AndNormalize(
                tokenIDs: ids,
                q8Bytes: q8Bytes,
                dataOffset: 15,
                scales: scales,
                rows: rows,
                dimensions: dims,
                backend: .scalar
            )
            for backend in AppleDocsKernels.Backend.allCases {
                let got = AppleDocsKernels.poolQ8AndNormalize(
                    tokenIDs: ids,
                    q8Bytes: q8Bytes,
                    dataOffset: 15,
                    scales: scales,
                    rows: rows,
                    dimensions: dims,
                    backend: backend
                )
                if got != ref { fail("poolQ8AndNormalize mismatch dims=\(dims) backend=\(backend)") }
            }
        }
    }

    private static func verifyLevenshtein() {
        for (lhs, rhs) in [
            ("navigationstack", "navigatonstak"),
            ("uicollectionviewcompositional", "uicollectionviewlayout"),
            ("café_éclair", "cafe_eclair"),
            (String(repeating: "abcdefghij", count: 8), String(repeating: "abcdefghik", count: 8)),
            ("", "abc")
        ] {
            let a = Array(lhs.utf16)
            let b = Array(rhs.utf16)
            for maxD in [0, 1, 2, 3, 5, 12] {
                let exp = referenceLevenshtein(a, b, maxDist: maxD)
                let got = AppleDocsKernels.levenshteinUTF16(a, b, maxDistance: maxD)
                if !(exp > maxD && got > maxD) && exp != got {
                    fail("levenshtein mismatch '\(lhs)' vs '\(rhs)' max=\(maxD): got \(got) exp \(exp)")
                }
            }
        }
    }
}

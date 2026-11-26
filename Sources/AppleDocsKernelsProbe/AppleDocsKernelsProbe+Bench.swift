import AppleDocsKernels
import Foundation

extension AppleDocsKernelsProbe {
    nonisolated(unsafe) private static var sinkDouble: Double = 0
    nonisolated(unsafe) private static var sinkInt = 0

    private static func nanosPerOp(_ iters: Int, _ body: () -> Void) -> Double {
        let clock = ContinuousClock()
        let start = clock.now
        for _ in 0 ..< iters { body() }
        let d = clock.now - start
        return (Double(d.components.seconds) * 1e9 + Double(d.components.attoseconds) * 1e-9) / Double(iters)
    }

    private static func printPair(_ label: String, unit: String, scalar: Double, fast: Double) {
        let div = unit == "ms" ? 1e6 : 1.0
        let fmt =
            unit == "ms" ? "%@: scalar=%.2f%@  %@=%.2f%@  speedup=%.2fx" : "%@: scalar=%.0f%@  %@=%.0f%@  speedup=%.2fx"
        print(
            String(
                format: fmt,
                label,
                scalar / div,
                unit,
                AppleDocsKernels.activeBackend,
                fast / div,
                unit,
                scalar / fast
            )
        )
    }

    static func runBench() {
        var rng = XorShift64(state: 0xBEEF_CAFE_4242)
        benchHamming(&rng)
        benchVectors(&rng)
        benchLevenshtein()
    }

    private static func benchHamming(_ rng: inout XorShift64) {
        let rows = 100_000
        let query64 = (0 ..< 64).map { _ in rng.byte() }
        let packed64 = (0 ..< rows * 64).map { _ in rng.byte() }
        let sc = nanosPerOp(25) {
            sinkInt &+= Int(
                AppleDocsKernels.hammingDistances(query: query64, packed: packed64, byteWidth: 64, backend: .scalar)[0]
            )
        }
        let fa = nanosPerOp(50) {
            sinkInt &+= Int(
                AppleDocsKernels.hammingDistances(query: query64, packed: packed64, byteWidth: 64, backend: .fastest)[0]
            )
        }
        printPair("hamming_100k_x_512b", unit: "ms", scalar: sc, fast: fa)
    }

    private static func benchVectors(_ rng: inout XorShift64) {
        let fVec = (0 ..< 512).map { _ in rng.unitFloat() }
        let i8Vec = AppleDocsKernels.quantizeInt8(fVec, backend: .scalar)
        let dotSc = nanosPerOp(50_000) {
            sinkDouble += AppleDocsKernels.dotInt8(query: fVec, packedPayload: i8Vec, dimensions: 512, backend: .scalar)
        }
        let dotFa = nanosPerOp(50_000) {
            sinkDouble += AppleDocsKernels.dotInt8(
                query: fVec,
                packedPayload: i8Vec,
                dimensions: 512,
                backend: .fastest
            )
        }
        printPair("dot_i8_512d        ", unit: "ns", scalar: dotSc, fast: dotFa)

        let q8Rows = 256
        let q8Data = (0 ..< q8Rows * 512).map { _ in rng.byte() }
        let q8Scales = (0 ..< q8Rows).map { _ in Float(0.02) }
        let ids: [Int32] = Array(repeating: [1, 7, 19, 42, 88, 120, 200, 3], count: 2).flatMap { $0 }
        let poolSc = nanosPerOp(10_000) {
            sinkDouble += Double(
                AppleDocsKernels.poolQ8AndNormalize(
                    tokenIDs: ids,
                    q8Bytes: q8Data,
                    dataOffset: 0,
                    scales: q8Scales,
                    rows: q8Rows,
                    dimensions: 512,
                    backend: .scalar
                )[0]
            )
        }
        let poolFa = nanosPerOp(10_000) {
            sinkDouble += Double(
                AppleDocsKernels.poolQ8AndNormalize(
                    tokenIDs: ids,
                    q8Bytes: q8Data,
                    dataOffset: 0,
                    scales: q8Scales,
                    rows: q8Rows,
                    dimensions: 512,
                    backend: .fastest
                )[0]
            )
        }
        printPair("q8_pool_16tok_512d ", unit: "ns", scalar: poolSc, fast: poolFa)

        let qSc = nanosPerOp(20_000) { sinkInt &+= Int(AppleDocsKernels.quantizeInt8(fVec, backend: .scalar)[0]) }
        let qFa = nanosPerOp(20_000) { sinkInt &+= Int(AppleDocsKernels.quantizeInt8(fVec, backend: .fastest)[0]) }
        printPair("quantize_i8_512d   ", unit: "ns", scalar: qSc, fast: qFa)
    }

    private static func benchLevenshtein() {
        let a16 = Array("navigationstack".utf16)
        let b16 = Array("navigatonstak".utf16)
        let levSc = nanosPerOp(100_000) { sinkInt &+= referenceLevenshtein(a16, b16, maxDist: 3) }
        let levFa = nanosPerOp(100_000) { sinkInt &+= AppleDocsKernels.levenshteinUTF16(a16, b16, maxDistance: 3) }
        print(
            String(format: "levenshtein_15u16  : dp=%.0fns  myers64=%.0fns  speedup=%.2fx", levSc, levFa, levSc / levFa)
        )
    }
}

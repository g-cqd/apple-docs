/// Bun's `shortlistByHamming`: a bounded max-heap keyed by (distance, index) keeping the `size` nearest entries,
/// returned ascending by distance then index — ported operation for operation so ties resolve identically.
extension SemanticCandidates {
    struct Entry {
        let index: Int
        let distance: Int
    }

    static func shortlist(_ query: [UInt8], store: ChunkVectorStore, size: Int) -> [Entry] {
        var heapDistance = [Int](repeating: 0, count: size)
        var heapIndex = [Int](repeating: 0, count: size)
        var count = 0
        let width = store.byteWidth
        store.packed.withUnsafeBufferPointer { packed in
            for item in 0 ..< store.count {
                var distance = 0
                let base = item * width
                for byte in 0 ..< width { distance += (query[byte] ^ packed[base + byte]).nonzeroBitCount }
                if count < size {
                    var child = count
                    count += 1
                    while child > 0 {
                        let parent = (child - 1) >> 1
                        if heapDistance[parent] > distance
                            || (heapDistance[parent] == distance && heapIndex[parent] > item)
                        {
                            break
                        }
                        heapDistance[child] = heapDistance[parent]
                        heapIndex[child] = heapIndex[parent]
                        child = parent
                    }
                    heapDistance[child] = distance
                    heapIndex[child] = item
                } else if distance < heapDistance[0] {
                    siftDown(distance, item, size: size, distances: &heapDistance, indices: &heapIndex)
                }
            }
        }
        let entries = (0 ..< count).map { Entry(index: heapIndex[$0], distance: heapDistance[$0]) }
        return JSArraySort.sorted(entries) { lhs, rhs in
            let byDistance = lhs.distance - rhs.distance
            return Double(byDistance != 0 ? byDistance : lhs.index - rhs.index)
        }
    }

    private static func siftDown(_ distance: Int, _ item: Int, size: Int, distances: inout [Int], indices: inout [Int])
    {
        var node = 0
        while true {
            let left = 2 * node + 1
            let right = left + 1
            var bigDistance = distance
            var bigIndex = item
            var big = -1
            if left < size,
                distances[left] > bigDistance || (distances[left] == bigDistance && indices[left] > bigIndex)
            {
                big = left
                bigDistance = distances[left]
                bigIndex = indices[left]
            }
            if right < size,
                distances[right] > bigDistance || (distances[right] == bigDistance && indices[right] > bigIndex)
            {
                big = right
            }
            if big == -1 { break }
            distances[node] = distances[big]
            indices[node] = indices[big]
            node = big
        }
        distances[node] = distance
        indices[node] = item
    }
}

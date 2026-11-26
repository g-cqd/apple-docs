/// `Array.prototype.sort` as JavaScriptCore runs it (bottom-up merge sort): stable, and — because the merge only
/// takes the right element when `compare(right, left) < 0` — identical to Bun even for comparators that are not
/// strict weak orderings (Bun's ranking treats scores within 0.001 as equal).
enum JSArraySort {
    static func sorted<T>(_ items: [T], by compare: (T, T) -> Double) -> [T] {
        let count = items.count
        guard count > 1 else { return items }
        var source = items
        var destination = items
        var width = 1
        while width < count {
            var start = 0
            while start < count {
                let middle = min(start + width, count)
                let end = min(start + 2 * width, count)
                var left = start
                var right = middle
                var out = start
                while left < middle, right < end {
                    if compare(source[right], source[left]) < 0 {
                        destination[out] = source[right]
                        right += 1
                    } else {
                        destination[out] = source[left]
                        left += 1
                    }
                    out += 1
                }
                while left < middle {
                    destination[out] = source[left]
                    left += 1
                    out += 1
                }
                while right < end {
                    destination[out] = source[right]
                    right += 1
                    out += 1
                }
                start += 2 * width
            }
            swap(&source, &destination)
            width *= 2
        }
        return source
    }
}

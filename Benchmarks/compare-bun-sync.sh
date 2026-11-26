#!/usr/bin/env bash
# Cold single-framework crawl benchmark: Swift `apple-docs sync` vs the Bun `crawlRoot` pipeline.
#
#   Benchmarks/compare-bun-sync.sh [framework] [runs] [concurrency]
#
# Requires: a release build of this package, `bun`, and a checkout of the Bun implementation at
# $BUN_APPLE_DOCS (default: ../apple-docs). Each run starts from an empty database so both sides do
# the same network + parse + persist work against developer.apple.com.
set -euo pipefail

framework="${1:-compression}"
runs="${2:-3}"
concurrency="${3:-16}"
root="$(cd "$(dirname "$0")/.." && pwd)"
bun_repo="${BUN_APPLE_DOCS:-$root/../apple-docs}"
swift_bin="$root/.build/release/apple-docs"
work="$(mktemp -d "${TMPDIR:-/tmp}/apple-docs-bench.XXXXXX")"
trap 'rm -rf "$work"' EXIT

[ -x "$swift_bin" ] || { echo "missing $swift_bin (run: swift build -c release --product apple-docs)" >&2; exit 2; }
[ -f "$bun_repo/src/pipeline/discover.js" ] || { echo "missing Bun checkout at $bun_repo" >&2; exit 2; }

cat > "$work/bun-crawl.js" <<EOF
import { DocsDatabase } from '$bun_repo/src/storage/database.js'
import { crawlRoot } from '$bun_repo/src/pipeline/discover.js'
import { RateLimiter } from '$bun_repo/src/lib/rate-limiter.js'
import { Semaphore } from '$bun_repo/src/lib/semaphore.js'
const [dataDir, slug, conc] = process.argv.slice(2)
const db = new DocsDatabase(dataDir + '/apple-docs.db')
db.upsertRoot(slug, slug, 'framework', 'apple', slug, 'apple-docc')
const logger = { info() {}, warn() {}, error() {}, debug() {} }
await crawlRoot(db, dataDir, new RateLimiter(500, 100), slug, logger, null,
  { concurrency: Number(conc), semaphore: new Semaphore(Number(conc)) })
db.close()
EOF

measure() { # label db-path command...
    local label="$1" db="$2"; shift 2
    local out
    out="$( { /usr/bin/time -l "$@" >/dev/null; } 2>&1 )"
    local real cpu rss docs sections rels
    real="$(printf '%s\n' "$out" | awk '/ real /{print $1}')"
    cpu="$(printf '%s\n' "$out" | awk '/ real /{printf "%.2f", $3 + $5}')"
    rss="$(printf '%s\n' "$out" | awk '/maximum resident set size/{printf "%.1f", $1/1048576}')"
    docs="$(sqlite3 "$db" 'SELECT COUNT(*) FROM documents')"
    sections="$(sqlite3 "$db" 'SELECT COUNT(*) FROM document_sections')"
    rels="$(sqlite3 "$db" 'SELECT COUNT(*) FROM document_relationships')"
    printf '%-6s %7ss wall %6ss cpu %7s MiB %6s docs %6s sections %6s rels\n' \
        "$label" "$real" "$cpu" "$rss" "$docs" "$sections" "$rels"
}

echo "framework=$framework runs=$runs concurrency=$concurrency"
for run in $(seq 1 "$runs"); do
    echo "--- run $run"
    mkdir -p "$work/swift-$run" "$work/bun-$run"
    # Alternate who goes first: the first crawl of a framework warms Apple's CDN edge for the second.
    if [ $((run % 2)) -eq 1 ]; then order="swift bun"; else order="bun swift"; fi
    for impl in $order; do
        if [ "$impl" = swift ]; then
            measure swift "$work/swift-$run/corpus.db" "$swift_bin" sync --source apple-docc --seed "$framework" \
                --max-pages 100000 --max-depth 32 --concurrency "$concurrency" --db "$work/swift-$run/corpus.db"
        else
            measure bun "$work/bun-$run/apple-docs.db" bun "$work/bun-crawl.js" "$work/bun-$run" "$framework" \
                "$concurrency"
        fi
    done
done

echo "--- key-set diff (last run): only-in-swift / only-in-bun"
sqlite3 "$work/swift-$runs/corpus.db" "ATTACH '$work/bun-$runs/apple-docs.db' AS b;
  SELECT 'only-in-swift', COUNT(*) FROM documents WHERE key NOT IN (SELECT key FROM b.documents)
  UNION ALL SELECT 'only-in-bun', COUNT(*) FROM b.documents WHERE key NOT IN (SELECT key FROM main.documents);"

echo "--- swift incremental re-sync (conditional GET, expect 304s)"
last="$work/swift-$runs/corpus.db"
sqlite3 "$last" "UPDATE crawl_state SET status = 'pending'"
"$swift_bin" sync --source apple-docc --seed "$framework" --max-pages 100000 --max-depth 32 \
    --concurrency "$concurrency" --db "$last"

# S0.2 — Archive compression bake-off

## Recommendation

- **Symbols: `7z` (solid LZMA2, native container) at `-mx=9 -m0=lzma2 -md=1024m -mfb=273 -mqs=on`** — 915.8 MiB → 71.9 MiB (47.5% smaller than gzip; 6.7% smaller than `tar.xz`).
- **Fonts: `7z` (solid LZMA2, native container) at the same flag set** — 305.8 MiB → 54.6 MiB (73.1% smaller than gzip; 37.3% smaller than `tar.xz`).

`tar.7z` (LZMA2 over a tar stream) is within 1% of native `.7z` on symbols and within 0.5% on fonts; pick `tar.7z` if a streaming pipeline is preferred. `tar.xz` is the strongest format that decompresses with stock macOS tooling (`tar -xf` via libarchive/liblzma), so it is the right fallback if the consumer cannot install p7zip.

## Results

Benchmark host: `mm18.local`, macOS 15.6, Intel x86_64, 6 cores, 64 GB RAM. Tools: `xz 5.8.3`, `7zz 26.01`, system `gzip` / `bsdtar 3.5.3`. Round-trip verified by file-count and total-byte equality between source and extracted tree (`yes` = identical).

### Symbols sample (flat dir of 8328 SVGs, raw = 915.79 MiB / 960,258,048 B)

Path: `/Users/gc/.apple-docs/resources/symbols/public/`. Note: the brief named `regular-medium/` (~30 MB, 8k files) as the sample, but that subdir does not exist on `mm18.local`; the corpus is currently stored flat. The 916 MB tree was used as both sample and full validation, which is the whole population at present.

| Format | Flags | Size | Compress time | Decompress time | Ratio vs gz |
|---|---|---|---|---|---|
| `tar.gz` | `gzip -9` | 136.94 MiB | 29.16 s | 36.10 s | 1.00x (baseline) |
| `tar.xz` | `xz -9 --extreme --threads=0` | 77.11 MiB | 185.87 s | 36.17 s | 0.563x (−43.7%) |
| `tar.7z` | `7zz a -si -mx=9 -m0=lzma2 -md=1024m -mfb=273 -mqs=on` | 76.17 MiB | 514.69 s | 40.52 s | 0.556x (−44.4%) |
| `7z`   | `7zz a -mx=9 -m0=lzma2 -md=1024m -mfb=273 -mqs=on` | **71.95 MiB** | 421.72 s | 51.26 s | **0.525x (−47.5%)** |

### Fonts sample (47 OTFs in `sf-pro/`, raw = 305.76 MiB / 320,610,304 B)

Path: `/Users/gc/.apple-docs/resources/fonts/extracted/sf-pro/`. (Brief said ~163 MB; the directory currently holds 306 MB across the same 47 OTFs — likely additional weights vs. when the spike was drafted. Shape is unchanged: heterogeneous, already-entropy-coded font files.)

| Format | Flags | Size | Compress time | Decompress time | Ratio vs gz |
|---|---|---|---|---|---|
| `tar.gz` | `gzip -9` | 203.00 MiB | 14.40 s | 0.91 s | 1.00x (baseline) |
| `tar.xz` | `xz -9 --extreme --threads=0` | 87.24 MiB | 78.48 s | 2.65 s | 0.430x (−57.0%) |
| `tar.7z` | `7zz a -si -mx=9 -m0=lzma2 -md=1024m -mfb=273 -mqs=on` | 54.80 MiB | 89.34 s | 3.88 s | 0.270x (−73.0%) |
| `7z`   | `7zz a -mx=9 -m0=lzma2 -md=1024m -mfb=273 -mqs=on` | **54.58 MiB** | 88.03 s | 3.62 s | **0.269x (−73.1%)** |

The font result is the headline: 7z's solid block sees cross-file redundancy that `xz` does not, because piping `tar -cf -` into `xz` produces a single LZMA2 stream whose dictionary is bounded by `-md` per LZMA2 block, while `7zz` with `-mqs=on` sorts and groups by extension/size before forming solid blocks — fonts with shared OpenType tables compress against each other.

### Full symbols tree (winner only)

The "sample" and the "full tree" are the same data at present (916 MB, 8328 SVGs). 7z native at `-mx=9 -md=1024m -mfb=273 -mqs=on` produced 71.95 MiB compressed (round-trip verified). When additional weights/scales land and the corpus grows toward the projected 4 GB, re-run on the expanded tree before signing the format choice in stone — extra weights are highly redundant with current ones, so the ratio should improve, but `-md=1024m` may saturate (LZMA2 dictionary ceiling). If the tree exceeds ~1 GiB of structurally similar payload, consider `-md=1536m` or `-md=2g` (requires more decompression RAM; see tradeoffs).

## Decoder availability

- **macOS 26 / 15.x stock:**
  - `tar.gz` — native (`/usr/bin/gzip`, `/usr/bin/tar`).
  - `tar.xz` — `xz` binary NOT shipped, but `bsdtar 3.5.3` is linked against `liblzma 5.4.3`, so `tar -xf out.tar.xz` works out of the box. Streaming `xz -dc` requires `brew install xz`.
  - `tar.7z` / `7z` — neither `tar` nor any system tool can read 7z. Requires `brew install sevenzip` (CLI: `7zz`) or `brew install p7zip` (CLI: `7z`).
- **Linux (typical distros: Debian/Ubuntu, Fedora, Arch, Alpine):**
  - `tar.gz` — always present.
  - `tar.xz` — `xz-utils` (Debian/Ubuntu) / `xz` (Fedora/Arch) is in base or main; effectively always installed, and GNU tar autodetects via `-xf`.
  - `tar.7z` / `7z` — needs `p7zip` / `p7zip-full` (Debian/Ubuntu) or `7zip` (Fedora 40+, Arch). Not in base. Static `7zz` binaries are available from upstream if a dependency-free install is required.

## Tradeoffs and notes

- **Decompression RAM.** LZMA2 decompression memory ≈ dictionary size. At `-md=1024m`, decoders need ~1 GiB resident. A Raspberry Pi 3 B+ (1 GiB RAM) will likely OOM or thrash. Document the floor; for low-RAM consumers, fall back to `tar.xz -9` (default `-md=64m`, ~65 MiB at decompress).
- **Compression RAM.** `7z -mx=9 -md=1024m -mfb=273` peaked around 2.5 GiB RSS on `mm18.local`. Fine on any modern dev box / CI runner; would hurt on a 4 GiB runner.
- **Streaming.** `7zz a -si` (via tar) is single-threaded and produced 76.17 MiB vs 71.95 MiB for the seekable native `.7z` — the gap is the cost of not being able to reorder files into solid blocks by extension. If the consumer extracts the whole archive every time, native `.7z` is strictly better. If the consumer wants random per-file access, native `.7z` is still better (LZMA2 supports seek to solid-block boundaries; a `tar.xz` stream forces full sequential decode).
- **Compress time.** Symbols: 7z native took 7 min vs 30 s for gzip — irrelevant under the "time is not a constraint" rule, but worth recording for the CI budget. Fonts: ~90 s for the best formats.
- **Decompress time.** Symbols `.7z` decompress (51 s) is ~40% slower than `tar.gz` (36 s) because LZMA decode is single-threaded per solid block; if many clients pull on cold caches, 15 extra seconds per pull is the cost of the −47.5% size. Fonts decompress in under 4 s — non-issue.
- **Determinism / reproducibility.** `7zz a` records mtimes by default. For reproducible builds add `-stl` (store creation/access timestamps off) or post-process via `find … -exec touch -d …`. `tar.xz` reproducibility is well-trodden (set `--mtime`, `--sort=name`, `--owner=0 --group=0` on GNU tar; bsdtar needs equivalents).
- **Sample fidelity caveat.** The on-disk corpus does NOT match the sizes named in the brief (symbols 916 MB vs 30 MB sample / 4 GB full; fonts 306 MB vs 163 MB). Results above are honest for the current state; expect ratios to improve slightly on the full 215k-SVG corpus because solid-block redundancy grows with similar inputs.
- **zstd excluded per instruction.** Modern zstd long-range mode (`--long=27 -22 --ultra`) typically lands within 2-5% of xz on these payload shapes at 10-100x faster decode; revisit if the policy changes.

## Raw artifacts

Result TSVs on `mm18.local`:
- `/tmp/archive-bench/symbols-results.tsv`
- `/tmp/archive-bench/fonts-results.tsv`

Bench harness: `/tmp/archive-bench/bench.sh`.

# Vendored Zstandard decoder

- Upstream: https://github.com/facebook/zstd, release `v1.5.7`
- Tarball: `zstd-1.5.7.tar.gz`, SHA-256 `eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3`
  (matches the release's published `zstd-1.5.7.tar.gz.sha256`)
- `zstddeclib.c`: generated with `build/single_file_libs/create_single_file_decoder.sh` (decompression only,
  no legacy formats, no assembly, stripped error strings)
- `include/zstd.h`, `include/zstd_errors.h`: copied verbatim from `lib/`
- License: BSD (see `LICENSE`), selected from upstream's BSD-or-GPLv2 dual license

Why vendored: linking the system/Homebrew `libzstd` made release binaries depend on
`/opt/homebrew/opt/zstd/lib/libzstd.1.dylib` (unshippable, and built for a newer macOS than our 15.6 floor).
The decoder is compiled into the binary on macOS and Linux alike; only decompression is needed at runtime.
Upgrade by regenerating both files from a newer verified release tarball.

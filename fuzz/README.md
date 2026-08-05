# Fuzz targets

Jazzer.js fuzz targets for the parsers that handle bytes we did not write.
Run continuously by ClusterFuzzLite (see `.clusterfuzzlite/`), and on every
pull request against the code the PR touches.

## What is fuzzed, and why

Everything here sits on a trust boundary — the input arrives from a
downloaded archive, a tar listing, or a document body:

| Target | Under test | The property that must hold |
| --- | --- | --- |
| `fuzz-storage-key.js` | `validateStorageKey` | If it returns, the key cannot traverse. A key that survives validation and still contains `..`, a leading `/`, a NUL, or a backslash is a path-traversal hole. |
| `fuzz-tar-line.js` | `parseTarVerboseLine` | Never throws on arbitrary `tar -tv` output, and never reports a directory entry as a file (the archive validator keys its path checks off `type`). |
| `fuzz-zstd-header.js` | `zstdContentSize` | Never throws on a malformed frame header, and never returns a negative or non-finite size — the value feeds the disk preflight's arithmetic. |
| `fuzz-markdown.js` | `extractFrontmatter` | Never throws, and never returns a body longer than its input. |

## Node, not Bun

Jazzer.js runs on Node. The modules above are Node-clean: every `Bun.*`
reference in them lives inside a function these targets do not call
(`safeFilename`'s hasher, `requiredBytesForArchive`'s `Bun.file`, the async
archive validators' `Bun.spawn`). Keep it that way — a target that pulls in
a Bun global fails at import time inside the OSS-Fuzz image, not at runtime,
so it is easy to miss.

## Running one locally

```bash
bun x @jazzer.js/core fuzz/fuzz-storage-key.js --sync -- -runs=100000
```

A crash writes a `crash-<sha>` file; feed it back with:

```bash
bun x @jazzer.js/core fuzz/fuzz-storage-key.js --sync -- crash-<sha>
```

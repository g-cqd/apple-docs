#!/bin/bash -eu
#
# Build every fuzz/fuzz-*.js target into the OSS-Fuzz output directory.
#
# No `npm install`. The targets reach exactly 13 project modules and zero
# third-party packages — only Node builtins — so installing the project's
# dependency tree would add minutes to every build and drag in heavy,
# platform-sensitive optional deps (@huggingface/transformers, playwright,
# sharp) that no fuzz target imports. If a future target needs a real
# dependency, install it explicitly here rather than reaching for a blanket
# `npm install`; keep the check in fuzz/README.md honest.
#
# The project is ESM ("type": "module"), so the targets `export function
# fuzz(data)` rather than assigning module.exports.

for target in "$SRC/apple-docs"/fuzz/fuzz-*.js; do
  name="$(basename "$target" .js)"
  echo "building fuzz target: $name"
  # --sync: the targets are synchronous, which lets libFuzzer drive them
  # without the async harness overhead (~37k exec/s locally).
  compile_javascript_fuzzer apple-docs "fuzz/$name.js" --sync
done

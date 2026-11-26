#!/usr/bin/env bash
# Nightly fuzz pass: every harness for FUZZ_SECONDS (default 120) on its committed seed corpus. Any crash, trap,
# ASan report, or leak fails the run; the reproducer is left in Fuzz/Artifacts/<Target>/ (uploaded by CI).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
seconds="${FUZZ_SECONDS:-120}"
status=0
for target in $(ls "$here/Sources"); do
    echo "::group::$target (${seconds}s)"
    if ! "$here/run.sh" "$target" "$seconds"; then
        echo "::error title=Fuzz finding::$target failed; see Fuzz/Artifacts/$target"
        status=1
    fi
    echo "::endgroup::"
done
exit "$status"

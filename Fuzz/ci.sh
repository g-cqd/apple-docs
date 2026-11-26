#!/usr/bin/env bash
# Nightly fuzz pass: every harness for FUZZ_SECONDS (default 120) on its committed seed corpus. Any crash, trap,
# ASan report, or leak fails the run; the reproducer is left in Fuzz/Artifacts/<Target>/ (uploaded by CI).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
seconds="${FUZZ_SECONDS:-120}"
# The official Swift images lack SQLite headers (CSQLite); CI containers run as root.
if [ ! -e /usr/include/sqlite3.h ] && [ "$(id -u)" = 0 ]; then
    apt-get update -qq && apt-get install -y -qq --no-install-recommends libsqlite3-dev > /dev/null
fi
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

// Single source of truth for the package version.
//
// A JSON import (not a runtime readFileSync) is deliberate: it is inlined
// by `bun build --compile`, so the standalone binary reports the right
// version with no package.json on disk, and it resolves correctly when the
// package is installed from npm (package.json always ships).

import pkg from '../../package.json'

/** @type {string} */
export const VERSION = pkg.version

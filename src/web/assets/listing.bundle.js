// Bundle entry for /assets/listing.js — loaded only on framework-listing
// pages and the homepage where the framework filter UI is present.
//
// Order matters: tree-view sets up the tree DOM and emits
// `list-container:ready` when it swaps modes, which collection-filters
// listens for. Calling initTree first means the listener is registered
// AFTER the first event might fire — but tree-view defers the
// `setViewMode('tree')` call inside init() to a microtask boundary so
// the order here is safe either way. We init filters first because the
// hash-restore logic primes URL state before tree-view reads it.
import { init as initFilters } from './collection-filters.js'
import { init as initTree } from './tree-view.js'

initFilters()
initTree()

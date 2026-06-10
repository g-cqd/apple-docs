// Bundle entry for /assets/listing.js — loaded only on framework-listing
// pages and the homepage where the framework filter UI is present.
//
// Filters init first so the hash-restore logic primes URL state before
// tree-view reads it; filters operate on the server-rendered list,
// which only exists on treeless and scope-grouped roots.
import { init as initFilters } from './collection-filters.js'
import { init as initTree } from './tree-view.js'

initFilters()
initTree()

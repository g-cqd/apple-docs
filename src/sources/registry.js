import { AppleDoccAdapter } from './apple-docc.js'
import { AppleArchiveAdapter } from './apple-archive.js'
import { SourceAdapter } from './base.js'
import { GuidelinesAdapter } from './guidelines.js'
import { PackagesAdapter } from './packages.js'
import { HigAdapter } from './hig.js'
import { SampleCodeAdapter } from './sample-code.js'
import { SwiftBookAdapter } from './swift-book.js'
import { SwiftEvolutionAdapter } from './swift-evolution.js'
import { SwiftOrgAdapter } from './swift-org.js'
import { WwdcAdapter } from './wwdc.js'

const registry = new Map()

function registerAdapter(AdapterClass) {
  if (!(AdapterClass.prototype instanceof SourceAdapter)) {
    throw new Error('Adapter must extend SourceAdapter')
  }
  registry.set(AdapterClass.type, AdapterClass)
}

export function getAdapter(sourceType) {
  const AdapterClass = registry.get(sourceType)
  if (!AdapterClass) {
    throw new Error(`Unknown source type: ${sourceType}`)
  }
  return new AdapterClass()
}

export function getAllAdapters() {
  return [...registry.values()].map(AdapterClass => new AdapterClass())
}

export function getAdapterTypes() {
  return [...registry.keys()]
}

// Phase 0-2 adapters
registerAdapter(AppleDoccAdapter)
registerAdapter(HigAdapter)
registerAdapter(GuidelinesAdapter)

// Phase 4 adapters
registerAdapter(SwiftEvolutionAdapter)
registerAdapter(SwiftBookAdapter)
registerAdapter(SwiftOrgAdapter)
registerAdapter(AppleArchiveAdapter)
registerAdapter(WwdcAdapter)
registerAdapter(SampleCodeAdapter)
registerAdapter(PackagesAdapter)

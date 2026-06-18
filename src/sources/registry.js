// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { AssertionError, NotFoundError } from '../lib/errors.js'
import { AppleArchiveAdapter } from './apple-archive.js'
import { AppleDoccAdapter } from './apple-docc.js'
import { SourceAdapter } from './base.js'
import { ExternalDoccAdapter } from './external-docc.js'
import { GuidelinesAdapter } from './guidelines.js'
import { HigAdapter } from './hig.js'
import { PackagesAdapter } from './packages.js'
import { SampleCodeAdapter } from './sample-code.js'
import { SwiftBookAdapter } from './swift-book.js'
import { SwiftDoccAdapter } from './swift-docc.js'
import { SwiftEvolutionAdapter } from './swift-evolution.js'
import { SwiftOrgAdapter } from './swift-org.js'
import { WwdcAdapter } from './wwdc.js'

const registry = new Map()

function registerAdapter(AdapterClass) {
  if (!(AdapterClass.prototype instanceof SourceAdapter)) {
    throw new AssertionError('Adapter must extend SourceAdapter')
  }
  registry.set(AdapterClass.type, AdapterClass)
}

export function getAdapter(sourceType) {
  const AdapterClass = registry.get(sourceType)
  if (!AdapterClass) {
    throw new NotFoundError(sourceType, `Unknown source type: ${sourceType}`)
  }
  return new AdapterClass()
}

export function getAllAdapters() {
  return [...registry.values()].map((AdapterClass) => new AdapterClass())
}

export function getAdapterTypes() {
  return [...registry.keys()]
}

// Apple-side adapters
registerAdapter(AppleDoccAdapter)
registerAdapter(HigAdapter)
registerAdapter(GuidelinesAdapter)

// Swift / community adapters
registerAdapter(SwiftEvolutionAdapter)
registerAdapter(SwiftBookAdapter)
registerAdapter(SwiftDoccAdapter)
registerAdapter(ExternalDoccAdapter)
registerAdapter(SwiftOrgAdapter)
registerAdapter(AppleArchiveAdapter)
registerAdapter(WwdcAdapter)
registerAdapter(SampleCodeAdapter)
registerAdapter(PackagesAdapter)

import { fetchHtmlPage } from '../apple/api.js'
import { parseHtmlToNormalized } from '../content/parse-html.js'
import { SourceAdapter } from './base.js'

const ROOT_SLUG = 'apple-archive'
const ARCHIVE_BASE = 'https://developer.apple.com/library/archive'

/**
 * Curated list of well-known Apple Developer Archive guide paths.
 * Each entry is the path relative to ARCHIVE_BASE, including the filename.
 * The key is derived by stripping the filename, keeping only the directory.
 *
 * These guides are frozen (no longer updated), so the adapter uses 'flat'
 * sync mode and always returns 'unchanged' on subsequent check() calls.
 */
const ARCHIVE_GUIDES = [
  // Objective-C and language fundamentals
  'documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/MemoryMgmt/Articles/MemoryMgmt.html',
  'documentation/Cocoa/Conceptual/KeyValueObserving/KeyValueObserving.html',
  'documentation/Cocoa/Conceptual/KeyValueCoding/index.html',
  'documentation/Cocoa/Conceptual/Notifications/Introduction/introNotifications.html',
  'documentation/Cocoa/Conceptual/Blocks/Articles/00_Introduction.html',
  'documentation/Cocoa/Conceptual/ObjCRuntimeGuide/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/ObjCRuntimeGuide/Articles/ocrtTypeEncodings.html',
  'documentation/Cocoa/Conceptual/ObjCRuntimeGuide/Articles/ocrtForwarding.html',

  // Core Data and persistence
  'documentation/Cocoa/Conceptual/CoreData/index.html',
  'documentation/Cocoa/Conceptual/Predicates/predicates.html',

  // Networking
  'documentation/Cocoa/Conceptual/URLLoadingSystem/URLLoadingSystem.html',

  // Cocoa fundamentals and patterns
  'documentation/Cocoa/Conceptual/CocoaEncyclopedia/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/CocoaBindings/CocoaBindings.html',
  'documentation/Cocoa/Conceptual/CoreAnimation_guide/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/CoreAnimation_guide/CoreAnimationBasics/CoreAnimationBasics.html',
  'documentation/Cocoa/Conceptual/DrawingGuide/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/BinaryData/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/Archiving/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/Collections/Collections.html',
  'documentation/Cocoa/Conceptual/NumbersandValues/NumbersandValues.html',
  'documentation/Cocoa/Conceptual/Strings/introStrings.html',
  'documentation/Cocoa/Conceptual/AttributedStrings/AttributedStrings.html',
  'documentation/Cocoa/Conceptual/TextLayout/TextLayout.html',

  // Application lifecycle and UI
  'documentation/Cocoa/Conceptual/EventOverview/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/ResponderChain/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/ErrorHandlingCocoa/ErrorHandling.html',
  'documentation/Cocoa/Conceptual/UndoArchitecture/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/MultithreadingCocoaObjectivec/Introduction/Introduction.html',

  // General / DevPedia
  'documentation/General/Conceptual/DevPedia-CocoaCore/Accessibility.html',
  'documentation/General/Conceptual/DevPedia-CocoaCore/MVC.html',
  'documentation/General/Conceptual/DevPedia-CocoaCore/Delegation.html',
  'documentation/General/Conceptual/DevPedia-CocoaCore/Singleton.html',
  'documentation/General/Conceptual/DevPedia-CocoaCore/DesignPattern.html',
  'documentation/General/Conceptual/DevPedia-CocoaCore/Notification.html',
  'documentation/General/Conceptual/DevPedia-CocoaCore/ObjectCreation.html',
  'documentation/General/Conceptual/DevPedia-CocoaCore/Category.html',
  'documentation/General/Conceptual/DevPedia-CocoaCore/Protocol.html',
  'documentation/General/Conceptual/DevPedia-CocoaCore/ClassClusters.html',
  'documentation/General/Conceptual/ConcurrencyProgrammingGuide/Introduction/Introduction.html',

  // Developer Tools
  'documentation/DeveloperTools/Conceptual/InstrumentsUserGuide/index.html',
  'documentation/DeveloperTools/Conceptual/DynamicLibraries/000-Introduction/Introduction.html',
  'documentation/DeveloperTools/Conceptual/XcodeBuildSystem/Introduction/Introduction.html',
  'documentation/DeveloperTools/Conceptual/testing_with_xcode/chapters/01-introduction.html',

  // macOS AppKit
  'documentation/Cocoa/Conceptual/AppArchitecture/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/WinPanel/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/Documents/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/TableView/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/OutlineView/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/Toolbar/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/SyncServices/Introduction/Introduction.html',
  'documentation/Cocoa/Conceptual/SpellChecking/Introduction/Introduction.html',

  // iOS / UIKit legacy
  'documentation/iPhone/Conceptual/iPhoneOSProgrammingGuide/Introduction/Introduction.html',
  'documentation/UIKit/Conceptual/UIKitUICatalog/UIButton.html',
  'documentation/UIKit/Conceptual/UIKitUICatalog/UILabel.html',
  'documentation/UIKit/Conceptual/UIKitUICatalog/UITableView.html',
  'documentation/WindowsViews/Conceptual/ViewPG_iPhoneOS/Introduction/Introduction.html',
  'documentation/EventHandling/Conceptual/EventHandlingiPhoneOS/Introduction/Introduction.html',

  // Core Foundation
  'documentation/CoreFoundation/Conceptual/CFDesignConcepts/CFDesignConcepts.html',
  'documentation/CoreFoundation/Conceptual/CFMemoryMgmt/CFMemoryMgmt.html',
  'documentation/CoreFoundation/Conceptual/CFStrings/introduction.html',
  'documentation/CoreFoundation/Conceptual/CFCollections/CFCollections.html',

  // Graphics and media
  'documentation/GraphicsImaging/Conceptual/CoreImaging/ci_intro/ci_intro.html',
  'documentation/GraphicsImaging/Conceptual/drawingwithquartz2d/Introduction/Introduction.html',
  'documentation/GraphicsImaging/Conceptual/OpenGL-MacProgGuide/opengl_intro/opengl_intro.html',
  'documentation/AudioVideo/Conceptual/AVFoundationPG/Articles/00_Introduction.html',

  // Security
  'documentation/Security/Conceptual/keychainServConcepts/01chapter_Introduction_chapter_1_section_1.html',
  'documentation/Security/Conceptual/cryptoservices/Introduction/Introduction.html',
]

/**
 * Derive the canonical key for an archive guide path.
 * Strips the filename from the path to produce the directory key.
 *
 * @param {string} guidePath - e.g. 'documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction/Introduction.html'
 * @returns {string} - e.g. 'apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction'
 */
function pathToKey(guidePath) {
  const withoutFilename = guidePath.replace(/\/[^/]+\.html$/, '')
  return `${ROOT_SLUG}/${withoutFilename}`
}

/**
 * Reconstruct the canonical URL for an archive guide from its key.
 * Appends 'index.html' for index-style paths, otherwise uses the original filename.
 *
 * @param {string} key - e.g. 'apple-archive/documentation/Cocoa/Conceptual/KeyValueCoding'
 * @param {string[]} guidePaths - The full list of guide paths to search for a match.
 * @returns {string}
 */
function keyToUrl(key, guidePaths) {
  const pathPrefix = key.replace(`${ROOT_SLUG}/`, '')

  // Find the first guide path that starts with this directory path
  const match = guidePaths.find(p => p.startsWith(pathPrefix + '/') || p === pathPrefix)
  if (match) {
    return `${ARCHIVE_BASE}/${match}`
  }

  // Fallback: append index.html
  return `${ARCHIVE_BASE}/${pathPrefix}/index.html`
}

/**
 * Derive the framework name from an archive key path.
 * Extracts the top-level documentation area (e.g. 'cocoa', 'general', 'corefoundation').
 *
 * @param {string} key - e.g. 'apple-archive/documentation/Cocoa/Conceptual/...'
 * @returns {string|null}
 */
export function deriveFramework(key) {
  // key shape: apple-archive/documentation/<Framework>/...
  const parts = key.split('/')
  // parts[0] = 'apple-archive', parts[1] = 'documentation', parts[2] = framework segment
  const frameworkSegment = parts[2]
  if (!frameworkSegment) return null
  return frameworkSegment.toLowerCase()
}

export class AppleArchiveAdapter extends SourceAdapter {
  static type = 'apple-archive'
  static displayName = 'Apple Developer Archive'
  static syncMode = 'flat'

  async discover(ctx) {
    if (ctx.db && !ctx.db.getRootBySlug(ROOT_SLUG)) {
      ctx.db.upsertRoot(ROOT_SLUG, 'Apple Developer Archive', 'collection', ROOT_SLUG)
    }

    const root = ctx.db?.getRootBySlug(ROOT_SLUG) ?? null

    // Deduplicate keys: multiple guide paths may map to the same directory key
    const keySet = new Set(ARCHIVE_GUIDES.map(pathToKey))
    const keys = [...keySet]

    return this.validateDiscoveryResult({
      keys,
      roots: root ? [root] : undefined,
    })
  }

  async fetch(key, ctx) {
    const url = keyToUrl(key, ARCHIVE_GUIDES)
    const { html, etag, lastModified } = await fetchHtmlPage(url, ctx.rateLimiter)

    return this.validateFetchResult({
      key,
      payload: html,
      etag,
      lastModified,
    })
  }

  /**
   * Archive content is frozen and never updated by Apple.
   * Always return 'unchanged' to avoid unnecessary network requests.
   */
  async check(_key, _previousState, _ctx) {
    return this.validateCheckResult({
      status: 'unchanged',
      changed: false,
    })
  }

  normalize(key, rawPayload) {
    const html = typeof rawPayload === 'string' ? rawPayload : String(rawPayload)
    const url = keyToUrl(key, ARCHIVE_GUIDES)
    const framework = deriveFramework(key)

    const result = parseHtmlToNormalized(html, key, {
      sourceType: AppleArchiveAdapter.type,
      kind: 'archive-guide',
      framework,
      url,
      containerSelector: '#contents',
    })

    return this.validateNormalizeResult(result)
  }
}

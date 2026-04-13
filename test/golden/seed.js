/**
 * Seed an in-memory database with a representative set of pages
 * for golden search query testing. Covers multiple frameworks,
 * roles, and source types.
 */
export function seedDatabase(db) {
  // Frameworks
  const swiftui = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  const foundation = db.upsertRoot('foundation', 'Foundation', 'framework', 'test')
  const uikit = db.upsertRoot('uikit', 'UIKit', 'framework', 'test')
  const combine = db.upsertRoot('combine', 'Combine', 'framework', 'test')
  const design = db.upsertRoot('design', 'Human Interface Guidelines', 'design', 'test')
  const guidelines = db.upsertRoot('app-store-review', 'App Store Review Guidelines', 'guidelines', 'test')
  const swift = db.upsertRoot('swift', 'Swift', 'framework', 'test')

  // SwiftUI symbols
  const pages = [
    { rootId: swiftui.id, path: 'documentation/swiftui/view', url: 'u', title: 'View', role: 'symbol', roleHeading: 'Protocol', abstract: 'A type that represents part of your app user interface and provides modifiers', declaration: 'protocol View', platforms: ['iOS 13.0+', 'macOS 10.15+'], language: 'swift', minIos: '13.0', minMacos: '10.15' },
    { rootId: swiftui.id, path: 'documentation/swiftui/text', url: 'u', title: 'Text', role: 'symbol', roleHeading: 'Structure', abstract: 'A view that displays one or more lines of read-only text', declaration: 'struct Text', platforms: ['iOS 13.0+'], language: 'swift', minIos: '13.0' },
    { rootId: swiftui.id, path: 'documentation/swiftui/navigationstack', url: 'u', title: 'NavigationStack', role: 'symbol', roleHeading: 'Structure', abstract: 'A view that displays a root view and enables you to present additional views over the root view', declaration: 'struct NavigationStack<Data, Root> where Root : View', platforms: ['iOS 16.0+'], language: 'swift', minIos: '16.0', minMacos: '13.0' },
    { rootId: swiftui.id, path: 'documentation/swiftui/navigationsplitview', url: 'u', title: 'NavigationSplitView', role: 'symbol', roleHeading: 'Structure', abstract: 'A view that presents views in two or three columns', declaration: 'struct NavigationSplitView', platforms: ['iOS 16.0+'], language: 'swift', minIos: '16.0', minMacos: '13.0' },
    { rootId: swiftui.id, path: 'documentation/swiftui/navigationlink', url: 'u', title: 'NavigationLink', role: 'symbol', roleHeading: 'Structure', abstract: 'A view that controls a navigation presentation', declaration: 'struct NavigationLink<Label, Destination>', platforms: ['iOS 13.0+'], language: 'swift', minIos: '13.0' },
    { rootId: swiftui.id, path: 'documentation/swiftui/list', url: 'u', title: 'List', role: 'symbol', roleHeading: 'Structure', abstract: 'A container that presents rows of data arranged in a single column', declaration: 'struct List<SelectionValue, Content>', platforms: ['iOS 13.0+'], language: 'swift', minIos: '13.0' },
    { rootId: swiftui.id, path: 'documentation/swiftui/button', url: 'u', title: 'Button', role: 'symbol', roleHeading: 'Structure', abstract: 'A control that initiates an action', declaration: 'struct Button<Label> where Label : View' },
    { rootId: swiftui.id, path: 'documentation/swiftui/toggle', url: 'u', title: 'Toggle', role: 'symbol', roleHeading: 'Structure', abstract: 'A control that toggles between on and off states', declaration: 'struct Toggle<Label> where Label : View' },
    { rootId: swiftui.id, path: 'documentation/swiftui/environmentobject', url: 'u', title: 'EnvironmentObject', role: 'symbol', roleHeading: 'Property Wrapper', abstract: 'A property wrapper type for an observable object that a parent or ancestor view supplies', declaration: '@frozen @propertyWrapper struct EnvironmentObject<ObjectType>' },
    { rootId: swiftui.id, path: 'documentation/swiftui/stateobject', url: 'u', title: 'StateObject', role: 'symbol', roleHeading: 'Property Wrapper', abstract: 'A property wrapper type that instantiates an observable object', declaration: '@frozen @propertyWrapper struct StateObject<ObjectType>' },

    // Foundation symbols
    { rootId: foundation.id, path: 'documentation/foundation/urlsession', url: 'u', title: 'URLSession', role: 'symbol', roleHeading: 'Class', abstract: 'An object that coordinates a group of related network data transfer tasks', declaration: 'class URLSession', platforms: ['iOS 7.0+'], language: 'both', minIos: '7.0' },
    { rootId: foundation.id, path: 'documentation/foundation/data', url: 'u', title: 'Data', role: 'symbol', roleHeading: 'Structure', abstract: 'A byte buffer in memory', declaration: 'struct Data' },
    { rootId: foundation.id, path: 'documentation/foundation/string', url: 'u', title: 'String', role: 'symbol', roleHeading: 'Structure', abstract: 'A Unicode string value that is a collection of characters', declaration: 'struct String' },
    { rootId: foundation.id, path: 'documentation/foundation/url', url: 'u', title: 'URL', role: 'symbol', roleHeading: 'Structure', abstract: 'A value that identifies the location of a resource', declaration: 'struct URL' },
    { rootId: foundation.id, path: 'documentation/foundation/jsonencoder', url: 'u', title: 'JSONEncoder', role: 'symbol', roleHeading: 'Class', abstract: 'An object that encodes instances of a data type as JSON objects', declaration: 'class JSONEncoder' },
    { rootId: foundation.id, path: 'documentation/foundation/notification', url: 'u', title: 'Notification', role: 'symbol', roleHeading: 'Structure', abstract: 'A container for information broadcast through a notification center' },

    // UIKit symbols
    { rootId: uikit.id, path: 'documentation/uikit/uiview', url: 'u', title: 'UIView', role: 'symbol', roleHeading: 'Class', abstract: 'An object that manages the content for a rectangular area on the screen', declaration: 'class UIView : UIResponder', language: 'both', minIos: '2.0' },
    { rootId: uikit.id, path: 'documentation/uikit/uiviewcontroller', url: 'u', title: 'UIViewController', role: 'symbol', roleHeading: 'Class', abstract: 'An object that manages a view hierarchy for your UIKit app', declaration: 'class UIViewController : UIResponder', language: 'both', minIos: '2.0' },
    { rootId: uikit.id, path: 'documentation/uikit/uitableview', url: 'u', title: 'UITableView', role: 'symbol', roleHeading: 'Class', abstract: 'A view that presents data using rows in a single column', declaration: 'class UITableView : UIScrollView', language: 'both', minIos: '2.0' },

    // Combine
    { rootId: combine.id, path: 'documentation/combine/publisher', url: 'u', title: 'Publisher', role: 'symbol', roleHeading: 'Protocol', abstract: 'Declares that a type can transmit a sequence of values over time', declaration: 'protocol Publisher<Output, Failure>' },
    { rootId: combine.id, path: 'documentation/combine/subject', url: 'u', title: 'Subject', role: 'symbol', roleHeading: 'Protocol', abstract: 'A publisher that exposes a method for outside callers to publish elements', declaration: 'protocol Subject<Output, Failure> : AnyObject, Publisher' },

    // Swift concurrency
    { rootId: swift.id, path: 'documentation/swift/concurrency', url: 'u', title: 'Concurrency', role: 'article', abstract: 'Perform asynchronous operations with async and await' },
    { rootId: swift.id, path: 'documentation/swift/sendable', url: 'u', title: 'Sendable', role: 'symbol', roleHeading: 'Protocol', abstract: 'A type whose values can safely be passed across concurrency domains', declaration: 'protocol Sendable' },
    { rootId: swift.id, path: 'documentation/swift/actor', url: 'u', title: 'Actor', role: 'symbol', roleHeading: 'Protocol', abstract: 'Common protocol for all actors', declaration: 'protocol Actor : AnyObject, Sendable' },

    // HIG articles
    { rootId: design.id, path: 'design/human-interface-guidelines/layout', url: 'u', title: 'Layout', role: 'article', abstract: 'People generally expect apps to be consistent with the platform and other apps' },
    { rootId: design.id, path: 'design/human-interface-guidelines/typography', url: 'u', title: 'Typography', role: 'article', abstract: 'Apple platforms use the San Francisco system font' },
    { rootId: design.id, path: 'design/human-interface-guidelines/color', url: 'u', title: 'Color', role: 'article', abstract: 'Use color to communicate with people, not as decoration' },
    { rootId: design.id, path: 'design/human-interface-guidelines/accessibility', url: 'u', title: 'Accessibility', role: 'article', abstract: 'People use assistive technologies to adapt their devices to their needs' },

    // App Store Review Guidelines sections
    { rootId: guidelines.id, path: 'app-store-review/1.1', url: 'u', title: '1.1 - App Completeness', role: 'article', abstract: 'Submissions must be final versions not beta demos or trial versions' },
    { rootId: guidelines.id, path: 'app-store-review/3.1.1', url: 'u', title: '3.1.1 - In-App Purchase', role: 'article', abstract: 'If you want to unlock features or functionality within your app you must use in-app purchase' },
    { rootId: guidelines.id, path: 'app-store-review/4.0', url: 'u', title: '4.0 - Design', role: 'article', abstract: 'Apple customers place a high value on products that are simple refined innovative and easy to use' },
    { rootId: guidelines.id, path: 'app-store-review/5.1.1', url: 'u', title: '5.1.1 - Data Collection and Storage', role: 'article', abstract: 'Apps that collect user or usage data must secure user consent' },

    // Release notes (should be penalized in future ranking)
    { rootId: swiftui.id, path: 'documentation/swiftui/swiftui-release-notes/swiftui-ios17-release-notes', url: 'u', title: 'SwiftUI Release Notes for iOS 17', role: 'article', abstract: 'Update your apps to use new features and changes in SwiftUI for iOS 17' },
  ]

  for (const page of pages) {
    db.upsertPage({
      ...page,
      platforms: page.platforms ? JSON.stringify(page.platforms) : null,
    })
  }

  // --- Phase 4 sources (use normalized document model directly) ---

  const swiftEvolution = db.upsertRoot('swift-evolution', 'Swift Evolution Proposals', 'collection', 'swift-evolution')
  const swiftBook = db.upsertRoot('swift-book', 'The Swift Programming Language', 'collection', 'swift-book')
  const swiftOrg = db.upsertRoot('swift-org', 'Swift.org Documentation', 'collection', 'swift-org')
  const appleArchive = db.upsertRoot('apple-archive', 'Apple Developer Archive', 'collection', 'apple-archive')
  const wwdc = db.upsertRoot('wwdc', 'WWDC Session Transcripts', 'collection', 'wwdc')
  const sampleCode = db.upsertRoot('sample-code', 'Apple Sample Code', 'collection', 'sample-code')

  const normalizedDocs = [
    // Swift Evolution proposals
    {
      document: { sourceType: 'swift-evolution', key: 'swift-evolution/0296-async-await', title: 'SE-0296: Async/Await', kind: 'proposal', role: 'article', framework: 'swift-evolution', abstractText: 'Introduce async/await syntax for asynchronous programming in Swift', sourceMetadata: JSON.stringify({ seNumber: 'SE-0296', status: 'Implemented (Swift 5.5)', swiftVersion: '5.5', authors: 'John McCall, Doug Gregor' }) },
      sections: [{ sectionKind: 'abstract', contentText: 'Introduce async/await syntax for asynchronous programming in Swift', sortOrder: 0 }, { sectionKind: 'discussion', heading: 'Motivation', contentText: 'Asynchronous programming with completion handlers is difficult to read and error prone', sortOrder: 1 }],
      relationships: [],
    },
    {
      document: { sourceType: 'swift-evolution', key: 'swift-evolution/0302-sendable', title: 'SE-0302: Sendable and @Sendable closures', kind: 'proposal', role: 'article', framework: 'swift-evolution', abstractText: 'Introduce the Sendable protocol and @Sendable function types for safe concurrency', sourceMetadata: JSON.stringify({ seNumber: 'SE-0302', status: 'Implemented (Swift 5.5)', swiftVersion: '5.5' }) },
      sections: [{ sectionKind: 'abstract', contentText: 'Introduce the Sendable protocol and @Sendable function types for safe concurrency', sortOrder: 0 }],
      relationships: [],
    },
    {
      document: { sourceType: 'swift-evolution', key: 'swift-evolution/0395-observability', title: 'SE-0395: Observation', kind: 'proposal', role: 'article', framework: 'swift-evolution', abstractText: 'Introduce the Observation framework as a replacement for the Combine-based ObservableObject protocol', sourceMetadata: JSON.stringify({ seNumber: 'SE-0395', status: 'Implemented (Swift 5.9)', swiftVersion: '5.9' }) },
      sections: [{ sectionKind: 'abstract', contentText: 'Introduce the Observation framework as a replacement for the Combine-based ObservableObject protocol', sortOrder: 0 }],
      relationships: [],
    },

    // Swift Book chapters
    {
      document: { sourceType: 'swift-book', key: 'swift-book/TheBasics', title: 'The Basics', kind: 'book-chapter', role: 'article', framework: 'swift-book', url: 'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/thebasics', abstractText: 'Work with common kinds of data and write basic syntax' },
      sections: [{ sectionKind: 'abstract', contentText: 'Work with common kinds of data and write basic syntax', sortOrder: 0 }, { sectionKind: 'discussion', heading: 'Constants and Variables', contentText: 'Constants and variables associate a name with a value of a particular type', sortOrder: 1 }],
      relationships: [],
    },
    {
      document: { sourceType: 'swift-book', key: 'swift-book/Closures', title: 'Closures', kind: 'book-chapter', role: 'article', framework: 'swift-book', url: 'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/closures', abstractText: 'Group code that executes together without creating a named function' },
      sections: [{ sectionKind: 'abstract', contentText: 'Group code that executes together without creating a named function', sortOrder: 0 }],
      relationships: [],
    },
    {
      document: { sourceType: 'swift-book', key: 'swift-book/Concurrency', title: 'Concurrency', kind: 'book-chapter', role: 'article', framework: 'swift-book', url: 'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/concurrency', abstractText: 'Perform asynchronous operations using async/await, task groups, and actors' },
      sections: [{ sectionKind: 'abstract', contentText: 'Perform asynchronous operations using async/await, task groups, and actors', sortOrder: 0 }],
      relationships: [],
    },

    // Swift.org articles
    {
      document: { sourceType: 'swift-org', key: 'swift-org/documentation/api-design-guidelines', title: 'API Design Guidelines', kind: 'article', role: 'article', framework: 'swift-org', url: 'https://swift.org/documentation/api-design-guidelines', abstractText: 'Write clear usage at the point of call. Clarity is more important than brevity.' },
      sections: [{ sectionKind: 'abstract', contentText: 'Write clear usage at the point of call. Clarity is more important than brevity.', sortOrder: 0 }],
      relationships: [],
    },
    {
      document: { sourceType: 'swift-org', key: 'swift-org/migration-guide-swift6', title: 'Migrating to Swift 6', kind: 'article', role: 'article', framework: 'swift-org', url: 'https://swift.org/migration-guide-swift6', abstractText: 'A guide to migrating your project to Swift 6 strict concurrency checking' },
      sections: [{ sectionKind: 'abstract', contentText: 'A guide to migrating your project to Swift 6 strict concurrency checking', sortOrder: 0 }],
      relationships: [],
    },

    // Apple Archive guides
    {
      document: { sourceType: 'apple-archive', key: 'apple-archive/documentation/Cocoa/Conceptual/MemoryMgmt/Articles', title: 'Memory Management Programming Guide', kind: 'archive-guide', role: 'article', framework: 'cocoa', url: 'https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/MemoryMgmt/Articles/MemoryMgmt.html', abstractText: 'Application memory management is the process of allocating memory during runtime' },
      sections: [{ sectionKind: 'abstract', contentText: 'Application memory management is the process of allocating memory during runtime', sortOrder: 0 }],
      relationships: [],
    },
    {
      document: { sourceType: 'apple-archive', key: 'apple-archive/documentation/Cocoa/Conceptual/KeyValueObserving', title: 'Key-Value Observing Programming Guide', kind: 'archive-guide', role: 'article', framework: 'cocoa', url: 'https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/KeyValueObserving/KeyValueObserving.html', abstractText: 'Key-value observing provides a mechanism for objects to be notified of changes to specified properties' },
      sections: [{ sectionKind: 'abstract', contentText: 'Key-value observing provides a mechanism for objects to be notified of changes to specified properties', sortOrder: 0 }],
      relationships: [],
    },
    {
      document: { sourceType: 'apple-archive', key: 'apple-archive/documentation/General/Conceptual/DevPedia-CocoaCore/MVC', title: 'Model-View-Controller', kind: 'archive-guide', role: 'article', framework: 'general', url: 'https://developer.apple.com/library/archive/documentation/General/Conceptual/DevPedia-CocoaCore/MVC.html', abstractText: 'The Model-View-Controller design pattern assigns objects in an application one of three roles: model, view, or controller' },
      sections: [{ sectionKind: 'abstract', contentText: 'The Model-View-Controller design pattern assigns objects in an application one of three roles: model, view, or controller', sortOrder: 0 }],
      relationships: [],
    },

    // WWDC sessions
    {
      document: { sourceType: 'wwdc', key: 'wwdc/wwdc2024-10001', title: 'Meet Swift Testing', kind: 'wwdc-session', role: 'article', framework: 'wwdc', url: 'https://developer.apple.com/videos/play/wwdc2024/10001/', abstractText: 'Learn about the Swift Testing framework and how to write tests for your Swift packages and apps', sourceMetadata: JSON.stringify({ year: 2024, sessionId: '10001', source: 'apple' }) },
      sections: [{ sectionKind: 'abstract', contentText: 'Learn about the Swift Testing framework and how to write tests for your Swift packages and apps', sortOrder: 0 }, { sectionKind: 'content', heading: 'Transcript', contentText: 'Welcome to meet Swift Testing. Today we are going to explore the new testing framework built from the ground up for Swift.', sortOrder: 1 }],
      relationships: [],
    },
    {
      document: { sourceType: 'wwdc', key: 'wwdc/wwdc2023-10164', title: 'Discover Observation in SwiftUI', kind: 'wwdc-session', role: 'article', framework: 'wwdc', url: 'https://developer.apple.com/videos/play/wwdc2023/10164/', abstractText: 'Simplify your SwiftUI data models with Observation. Learn how the Observable macro can help you simplify models and improve performance.', sourceMetadata: JSON.stringify({ year: 2023, sessionId: '10164', source: 'apple' }) },
      sections: [{ sectionKind: 'abstract', contentText: 'Simplify your SwiftUI data models with Observation. Learn how the Observable macro can help you simplify models and improve performance.', sortOrder: 0 }],
      relationships: [],
    },
    {
      document: { sourceType: 'wwdc', key: 'wwdc/wwdc2019-234', title: 'Advances in Networking Part 1', kind: 'wwdc-session', role: 'article', framework: 'wwdc', url: 'https://developer.apple.com/videos/play/wwdc2019/234/', abstractText: null, sourceMetadata: JSON.stringify({ year: 2019, sessionId: '234', source: 'asciiwwdc' }) },
      sections: [{ sectionKind: 'content', heading: 'Transcript', contentText: 'Good morning everyone and welcome to advances in networking. Today we will cover low data mode, WebSocket support, and improvements to URLSession.', sortOrder: 0 }],
      relationships: [],
    },

    // Sample code projects
    {
      document: { sourceType: 'sample-code', key: 'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app', title: 'Food Truck: Building a SwiftUI Multiplatform App', kind: 'sample-project', role: 'sampleCode', framework: 'swiftui', url: 'https://developer.apple.com/documentation/swiftui/food-truck-building-a-swiftui-multiplatform-app', abstractText: 'Create a multiplatform app that serves food truck customers across iOS, macOS, and watchOS using SwiftUI', sourceMetadata: JSON.stringify({ sampleProject: true, frameworks: ['swiftui'] }) },
      sections: [{ sectionKind: 'abstract', contentText: 'Create a multiplatform app that serves food truck customers across iOS, macOS, and watchOS using SwiftUI', sortOrder: 0 }],
      relationships: [],
    },
    {
      document: { sourceType: 'sample-code', key: 'sample-code/realitykit/swift-splash-take-a-swim-with-a-new-swiftui-game-built-with-realitykit', title: 'Swift Splash', kind: 'sample-project', role: 'sampleCode', framework: 'realitykit', url: 'https://developer.apple.com/documentation/realitykit/swift-splash', abstractText: 'Use RealityKit to build an interactive game with 3D water effects on Apple Vision Pro', sourceMetadata: JSON.stringify({ sampleProject: true, frameworks: ['realitykit'] }) },
      sections: [{ sectionKind: 'abstract', contentText: 'Use RealityKit to build an interactive game with 3D water effects on Apple Vision Pro', sortOrder: 0 }],
      relationships: [],
    },
  ]

  for (const doc of normalizedDocs) {
    db.upsertNormalizedDocument(doc)
  }

  return { pageCount: pages.length + normalizedDocs.length }
}

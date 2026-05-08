/**
 * @typedef {{ keys: string[], roots?: Array<object> }} DiscoveryResult
 * @typedef {{ key: string, payload: object, etag?: string|null, lastModified?: string|null }} FetchResult
 * @typedef {{ status: 'unchanged'|'modified'|'deleted'|'error', changed: boolean, newState?: object, deleted?: boolean }} CheckResult
 * @typedef {{ document: object, sections: object[], relationships: object[] }} NormalizeResult
 *
 * @typedef {object} EntryPoint
 * @property {string} slug      The owning root slug (e.g. 'swift-compiler').
 * @property {string} key       Storage key of the page that should be linked TO.
 * @property {string} title     Human-readable title shown in the link list.
 * @property {string} [summary] One-paragraph description for hover/excerpt text.
 * @property {string[]} parents Storage keys of pages that should display a
 *                              "Related Documentation" link to this entry.
 */

export class SourceAdapter {
  static type = 'base'
  static displayName = 'Base Source'
  static requiresNetwork = true
  /** @type {'crawl'|'flat'|'snapshot'} */
  static syncMode = 'crawl'

  /**
   * Optional cross-source entry points this adapter contributes. Listed here
   * so any page may opt in to surfacing them. The pipeline (or another adapter)
   * is responsible for injecting matching entries on the declared parent pages.
   * @type {EntryPoint[]}
   */
  static entryPoints = []

  async discover(_ctx) {
    throw new Error('Not implemented')
  }

  async fetch(_key, _ctx) {
    throw new Error('Not implemented')
  }

  async check(_key, _previousState, _ctx) {
    throw new Error('Not implemented')
  }

  normalize(_key, _rawPayload) {
    throw new Error('Not implemented')
  }

  extractReferences(_key, _rawPayload) {
    return []
  }

  renderHints() {
    return {}
  }

  validateDiscoveryResult(result) {
    if (!result || !Array.isArray(result.keys)) {
      throw new Error(`${this.constructor.type}.discover() must return { keys: [] }`)
    }
    return result
  }

  validateFetchResult(result) {
    if (!result || typeof result.key !== 'string' || result.payload == null) {
      throw new Error(`${this.constructor.type}.fetch() must return { key, payload }`)
    }
    return result
  }

  validateCheckResult(result) {
    const validStatuses = new Set(['unchanged', 'modified', 'deleted', 'error'])
    if (!result || !validStatuses.has(result.status)) {
      throw new Error(`${this.constructor.type}.check() must return a valid status`)
    }
    return result
  }

  validateNormalizeResult(result) {
    if (!result?.document || !Array.isArray(result?.sections) || !Array.isArray(result?.relationships)) {
      throw new Error(`${this.constructor.type}.normalize() must return { document, sections, relationships }`)
    }
    if (typeof result.document.key !== 'string') {
      throw new Error(`${this.constructor.type}.normalize() must return document.key`)
    }
    return result
  }
}

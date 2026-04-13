/**
 * @typedef {{ keys: string[], roots?: Array<object> }} DiscoveryResult
 * @typedef {{ key: string, payload: object, etag?: string|null, lastModified?: string|null }} FetchResult
 * @typedef {{ status: 'unchanged'|'modified'|'deleted'|'error', changed: boolean, newState?: object, deleted?: boolean }} CheckResult
 * @typedef {{ document: object, sections: object[], relationships: object[] }} NormalizeResult
 */

export class SourceAdapter {
  static type = 'base'
  static displayName = 'Base Source'
  static requiresNetwork = true
  /** @type {'crawl'|'flat'|'snapshot'} */
  static syncMode = 'crawl'

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

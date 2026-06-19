/**
 * @typedef {{ keys: string[], roots?: Array<any> }} DiscoveryResult
 * @typedef {{ key: string, payload: any, etag?: string|null, lastModified?: string|null }} FetchResult
 * @typedef {{ status: 'unchanged'|'modified'|'deleted'|'error', changed: boolean, newState?: any, deleted?: boolean }} CheckResult
 * @typedef {{ document: any, sections: any[], relationships: any[] }} NormalizeResult
 *
 * @typedef {object} EntryPoint
 * @property {string} slug      The owning root slug (e.g. 'swift-compiler').
 * @property {string} key       Storage key of the page that should be linked TO.
 * @property {string} title     Human-readable title shown in the link list.
 * @property {string} [summary] One-paragraph description for hover/excerpt text.
 * @property {string[]} parents Storage keys of pages that should display a
 *                              "Related Documentation" link to this entry.
 */

import { AssertionError } from '../lib/errors.js'

export class SourceAdapter {
  static type = 'base'
  static displayName = 'Base Source'
  static requiresNetwork = true
  /** @type {string} */
  static syncMode = 'crawl'

  /**
   * Optional cross-source entry points this adapter contributes. Listed here
   * so any page may opt in to surfacing them. The pipeline (or another adapter)
   * is responsible for injecting matching entries on the declared parent pages.
   * @type {EntryPoint[]}
   */
  static entryPoints = []

  /** @param {any} _ctx @returns {Promise<any>} */
  async discover(_ctx) {
    throw new AssertionError('Not implemented')
  }

  /** @param {any} _key @param {any} _ctx @returns {Promise<any>} */
  async fetch(_key, _ctx) {
    throw new AssertionError('Not implemented')
  }

  /** @param {any} _key @param {any} _previousState @param {any} _ctx @returns {Promise<any>} */
  async check(_key, _previousState, _ctx) {
    throw new AssertionError('Not implemented')
  }

  /** @param {any} _key @param {any} _rawPayload @returns {any} */
  normalize(_key, _rawPayload) {
    throw new AssertionError('Not implemented')
  }

  /** @param {any} _key @param {any} _rawPayload @returns {any[]} */
  extractReferences(_key, _rawPayload) {
    return []
  }

  /** @returns {any} */
  renderHints() {
    return {}
  }

  /** @param {any} result */
  validateDiscoveryResult(result) {
    if (!result || !Array.isArray(result.keys)) {
      throw new AssertionError(`${/** @type {any} */ (this.constructor).type}.discover() must return { keys: [] }`)
    }
    return result
  }

  /** @param {any} result */
  validateFetchResult(result) {
    if (!result || typeof result.key !== 'string' || result.payload == null) {
      throw new AssertionError(`${/** @type {any} */ (this.constructor).type}.fetch() must return { key, payload }`)
    }
    return result
  }

  /** @param {any} result */
  validateCheckResult(result) {
    const validStatuses = new Set(['unchanged', 'modified', 'deleted', 'error'])
    if (!result || !validStatuses.has(result.status)) {
      throw new AssertionError(`${/** @type {any} */ (this.constructor).type}.check() must return a valid status`)
    }
    return result
  }

  /** @param {any} result */
  validateNormalizeResult(result) {
    if (!result?.document || !Array.isArray(result?.sections) || !Array.isArray(result?.relationships)) {
      throw new AssertionError(`${/** @type {any} */ (this.constructor).type}.normalize() must return { document, sections, relationships }`)
    }
    if (typeof result.document.key !== 'string') {
      throw new AssertionError(`${/** @type {any} */ (this.constructor).type}.normalize() must return document.key`)
    }
    return result
  }
}

/**
 * Typed error classes for upstream/parse/validation classification.
 *
 * Replaces ad-hoc `Object.assign(new Error(...), { status })` patterns so
 * callers can discriminate via `instanceof` rather than property sniffing,
 * and so logs/metrics see a stable `name`.
 *
 * Re-exports BackpressureError and BodyTooLargeError so consumers have one
 * import path for the error taxonomy.
 */

export { BackpressureError } from './semaphore.js'
export { BodyTooLargeError } from './http-body.js'

/**
 * HTTP-layer failure: upstream returned a non-2xx status (or the request was
 * aborted with a recognized status). `status` is the integer HTTP code, `url`
 * is the request target so logs don't lose context.
 */
export class HttpError extends Error {
  constructor(status, url, message) {
    super(message ?? `HTTP ${status} fetching ${url}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
  }
}

/**
 * 404-specialized HttpError. Lets call sites write `instanceof NotFoundError`
 * rather than `err.status === 404`. Inherits from HttpError so generic HTTP
 * handlers still match.
 */
export class NotFoundError extends HttpError {
  constructor(url, message) {
    super(404, url, message ?? `Not found: ${url}`)
    this.name = 'NotFoundError'
  }
}

/**
 * Payload could not be parsed (JSON.parse failure, unexpected shape, missing
 * required fields). Distinct from HttpError so retry policies can treat
 * "server is broken" differently from "network is broken".
 */
export class ParseError extends Error {
  constructor(message, { cause, source } = {}) {
    super(message)
    this.name = 'ParseError'
    if (cause !== undefined) this.cause = cause
    if (source !== undefined) this.source = source
  }
}

/**
 * Input failed boundary validation (bad source-type, malformed key, etc).
 * Different from ParseError — ValidationError is about caller-supplied input,
 * ParseError is about upstream-supplied payload.
 */
export class ValidationError extends Error {
  constructor(message, { field, value } = {}) {
    super(message)
    this.name = 'ValidationError'
    if (field !== undefined) this.field = field
    if (value !== undefined) this.value = value
  }
}

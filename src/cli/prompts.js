import { createInterface } from 'node:readline/promises'

/**
 * Ask a yes/no/always question on a TTY. Returns one of:
 *   - `'yes'`: accept once for this invocation.
 *   - `'no'`: decline.
 *   - `'always'`: accept and remember.
 *
 * Defaults to `'no'` on empty input or on any I/O failure.
 *
 * Input/output streams are injectable so callers can drive the prompt from
 * tests via `PassThrough` streams.
 *
 * @param {string} question
 * @param {object} [options]
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @returns {Promise<'yes' | 'no' | 'always'>}
 */
export async function promptYesNoAlways(question, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output, terminal: false })
  try {
    const answer = await rl.question(`${question} `)
    return interpretAnswer(answer)
  } catch {
    return 'no'
  } finally {
    rl.close()
  }
}

/**
 * Interpret free-form user input as one of the three canonical answers.
 *
 * @param {string} raw
 * @returns {'yes' | 'no' | 'always'}
 */
export function interpretAnswer(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'a' || value === 'always') return 'always'
  if (value === 'y' || value === 'yes') return 'yes'
  return 'no'
}

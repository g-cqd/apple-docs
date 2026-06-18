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
  const value = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (value === 'a' || value === 'always') return 'always'
  if (value === 'y' || value === 'yes') return 'yes'
  return 'no'
}

/**
 * Ask a single-choice question on a TTY. Prints a numbered menu and returns
 * the chosen `value`. Empty input or any I/O failure returns the default
 * choice's value. Streams are injectable so tests can drive the prompt.
 *
 * @template T
 * @param {string} question
 * @param {Array<{ label: string, value: T, hint?: string }>} choices
 * @param {object} [options]
 * @param {number} [options.defaultIndex]
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @returns {Promise<T>}
 */
export async function promptChoice(question, choices, { defaultIndex = 0, input = process.stdin, output = process.stdout } = {}) {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new TypeError('promptChoice requires a non-empty choices array')
  }
  const def = Math.min(Math.max(defaultIndex, 0), choices.length - 1)
  const rl = createInterface({ input, output, terminal: false })
  try {
    output.write(`${question}\n`)
    choices.forEach((c, i) => {
      const marker = i === def ? '*' : ' '
      output.write(`  ${marker} ${i + 1}) ${c.label}${c.hint ? ` — ${c.hint}` : ''}\n`)
    })
    const answer = await rl.question(`Choose [1-${choices.length}] (default ${def + 1}): `)
    return interpretChoice(answer, choices, def)
  } catch {
    return choices[def].value
  } finally {
    rl.close()
  }
}

/**
 * Map free-form input to a choice value. Accepts a 1-based index, or a
 * case-insensitive match against a choice's `value` or `label`. Empty or
 * unrecognized input returns the default choice's value.
 *
 * @template T
 * @param {string} raw
 * @param {Array<{ label: string, value: T }>} choices
 * @param {number} [defaultIndex]
 * @returns {T}
 */
export function interpretChoice(raw, choices, defaultIndex = 0) {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (value === '') return choices[defaultIndex].value
  const asNum = Number.parseInt(value, 10)
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= choices.length) {
    return choices[asNum - 1].value
  }
  const byValue = choices.find((c) => String(c.value).toLowerCase() === value)
  if (byValue) return byValue.value
  const byLabel = choices.find((c) => c.label.toLowerCase() === value)
  if (byLabel) return byLabel.value
  return choices[defaultIndex].value
}

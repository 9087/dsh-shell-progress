/**
 * The step splitter: a command's text in, its top-level steps out.
 *
 * PowerShell opens every block form (`if` / `foreach` / `for` / `while` /
 * `do` / `switch` / `try` / `function`) with a brace, so brace depth plus
 * column 0 decides almost every step — there is no shell parser here. The one
 * exception is a clause that CONTINUES the previous statement's block: `else`,
 * `elseif`, `catch`, `finally` and `do`'s `while` tail arrive back at depth 0 and
 * therefore look exactly like a new statement, so they are recognized by their
 * reserved leading word (see `clauseContinuation`).
 *
 * The splitter is deliberately CONSERVATIVE: anything it cannot decide
 * (unterminated quotes, block comments, here-strings, a line continuation,
 * unbalanced parentheses, unbalanced braces) abandons instrumentation and
 * lets the command run exactly as written. Coarser steps cost granularity; a
 * wrong step boundary would corrupt the display and could mis-attribute
 * output, so it is never worth guessing.
 *
 * @module dsh-shell-progress/split
 */

/** One top-level step of a command. */
export interface Step {
  /** 1-based line number in the original command text. */
  readonly line: number
  /** The line's text, without its terminator. */
  readonly text: string
}

/** The splitter's answer: the steps it found, and whether they can be trusted. */
export interface SplitResult {
  /** The top-level steps, in source order. */
  readonly steps: readonly Step[]
  /** False when the source holds a structure this splitter cannot decide. */
  readonly safe: boolean
  /** Why instrumentation was abandoned; present only when `safe` is false. */
  readonly reason?: string
}

/** What one line contributes to the brace/paren depth, and whether it was readable. */
export interface LineScan {
  /** Net brace depth change of this line, ignoring quoted text and comments. */
  readonly braces: number
  /** False when this line holds a construct the scanner cannot decide. */
  readonly safe: boolean
  /** Why the line was rejected; present only when `safe` is false. */
  readonly reason?: string
}

/**
 * Whether a line opens a construct whose extent cannot be decided line by
 * line. Every one of these is a legitimate PowerShell form that this plugin
 * simply refuses to instrument.
 * @param line - one source line.
 * @returns a refusal reason, or undefined when the line is decidable.
 */
function undecidable(line: string): string | undefined {
  const trimmed = line.trim()
  if (trimmed.startsWith('<#')) return 'block comment'
  if (trimmed.includes('#>')) return 'block comment'
  if (trimmed.startsWith("@'") || trimmed.startsWith('@"')) return 'here-string'
  if (trimmed === "'@" || trimmed === '"@') return 'here-string'
  // A backtick at end of line continues the statement onto the next one, which
  // would make two source lines one step.
  if (trimmed.endsWith('`')) return 'line continuation'
  return undefined
}

/**
 * Scan one line for its brace delta, skipping single-quoted strings,
 * double-quoted strings (honouring the backtick escape) and `#` comments.
 *
 * Parentheses are counted too, and any imbalance rejects the line: a `$( )`
 * or a call argument list that opens on one line and closes on another would
 * otherwise be reported as two steps.
 * @param line - one source line, without its terminator.
 * @returns the line's brace delta and whether it was decidable.
 */
export function scanLine(line: string): LineScan {
  let braces = 0
  let parens = 0
  let index = 0
  while (index < line.length) {
    const character = line[index]
    if (character === '#') break // a comment runs to the end of the line
    if (character === "'") {
      // A single-quoted string is literal: no escapes, not even for a quote.
      index += 1
      while (index < line.length && line[index] !== "'") index += 1
      if (index >= line.length) return { braces, safe: false, reason: 'unterminated single-quoted string' }
    } else if (character === '"') {
      index += 1
      let closed = false
      while (index < line.length) {
        if (line[index] === '`') {
          index += 2
          continue
        }
        if (line[index] === '"') {
          closed = true
          break
        }
        index += 1
      }
      if (!closed) return { braces, safe: false, reason: 'unterminated double-quoted string' }
    } else if (character === '{') {
      braces += 1
    } else if (character === '}') {
      braces -= 1
    } else if (character === '(') {
      parens += 1
    } else if (character === ')') {
      parens -= 1
    }
    index += 1
  }
  if (parens !== 0) return { braces, safe: false, reason: 'unbalanced parentheses on one line' }
  return { braces, safe: true }
}

/**
 * Whether this line continues the PREVIOUS statement's block rather than
 * starting a statement of its own.
 *
 * Brace depth cannot see these. `if () { }` balances its own braces, so a
 * following `else {` arrives at depth 0, at column 0 and not starting with `}` —
 * indistinguishable from a top-level statement — and a marker placed before it
 * lands between the closing `}` and its clause, turning a valid command into a
 * syntax error. The clause belongs to the previous step, so it must not become
 * one.
 *
 * `else`, `elseif`, `catch`, `finally` and `until` are reserved words that can
 * never begin a statement, so no context is needed to place them. `while` is the
 * ambiguous one: it opens a real loop, or closes a `do` block. Only a `do` block
 * can precede it as a clause, and that block is necessarily the statement just
 * seen, so the pending `do` is read off the previous step's own text.
 * @param text - one source line.
 * @param previousStep - the text of the last top-level step, if there was one.
 * @returns true when the line is a clause continuation rather than a step.
 */
function clauseContinuation(text: string, previousStep: string | undefined): boolean {
  const head = text.trimStart()
  if (/^(?:else|elseif|catch|finally|until)\b/i.test(head)) return true
  const pendingDo = previousStep !== undefined && /^do\b/i.test(previousStep.trimStart())
  return /^while\b/i.test(head) && pendingDo
}

/**
 * Split a command into its top-level steps.
 *
 * A step must be a non-empty line that starts at column 0, does not start with
 * `}`, sits at brace depth 0, and is not a clause continuing the previous step.
 * Loop bodies, block closers and clauses therefore never become steps, which is
 * what keeps one iteration from producing a marker — the whole point of
 * instrumenting only top-level steps.
 * @param source - the command text, any line ending.
 * @returns the steps found and whether instrumentation may proceed.
 */
export function splitSteps(source: string): SplitResult {
  const lines = source.split(/\r\n|\n|\r/)
  const steps: Step[] = []
  let depth = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    const refusal = undecidable(line)
    if (refusal !== undefined) return { steps, safe: false, reason: refusal }
    const atColumnZero = line[0] !== ' ' && line[0] !== '\t'
    const isCloser = line.trimStart().startsWith('}')
    const startsStep = atColumnZero && !isCloser && depth === 0
      && !clauseContinuation(line, steps.at(-1)?.text)
    if (startsStep) steps.push({ line: index + 1, text: line })
    const scan = scanLine(line)
    if (!scan.safe) return { steps, safe: false, reason: scan.reason ?? 'undecidable line' }
    depth += scan.braces
    if (depth < 0) return { steps, safe: false, reason: 'a closing brace has no opening brace' }
  }
  if (depth !== 0) return { steps, safe: false, reason: 'a block is never closed' }
  return { steps, safe: true }
}

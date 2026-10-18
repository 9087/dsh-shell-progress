/**
 * Task `;` normalization: one top-level statement per line, before anything is planned.
 *
 * WHY. The planner and the instrumenter are LINE-based on purpose (see `./plan` and
 * `./instrument`): a step owns a source line, its marker is prepended to that line, and the
 * line count survives instrumentation. An agent that writes `build; echo; test; echo; report`
 * as one line therefore gets ONE step — one segment, one row, one enormous hover card — even
 * though PowerShell sees five statements.
 *
 * WHAT THIS DOES. It rewrites the command so every top-level `;` ends its line: the same
 * characters, in the same order, with a newline after each boundary semicolon and the spaces
 * that followed it dropped. PowerShell treats `;` and a newline as the same statement
 * separator, so the script means the same thing; the existing marker machinery — verified at
 * the start of a line, with `$?` saved and restored — then applies unchanged, one step per
 * statement. This is why no marker or step-identity change is needed.
 *
 * WHEN IT REFUSES. This is a lexical scanner, not a parser, and it is deliberately timid:
 * quotes, `#` comments, here-strings, block comments, line continuations, unbalanced
 * `()`/`{}` and a `;;` (never valid PowerShell) all answer `undefined`, and the caller runs
 * the command exactly as written, one step. Nothing is guessed.
 *
 * The caller keeps the ORIGINAL text for anything user-facing (`text` stays what was typed;
 * each step carries an `anchor` into the normalized script, see `./split`), and executes the
 * normalized text only when it is instrumented.
 *
 * @module dsh-shell-progress/statements
 */

import type { Step } from './split.ts'

/** A command rewritten to one top-level statement per line. */
export interface NormalizedStatements {
  /** The rewritten command: same characters, newlines at top-level `;`. */
  readonly text: string
  /**
   * `originalLines[i]` is the 1-based line of the ORIGINAL command that normalized line
   * `i + 1` began on. Used to keep the card's line numbers truthful after rewriting.
   */
  readonly originalLines: readonly number[]
}

/** Whether a character is horizontal whitespace this scanner skips after a boundary. */
function horizontal(character: string | undefined): boolean {
  return character === ' ' || character === '\t'
}

/**
 * Rewrite a PowerShell command so each top-level `;` ends a line.
 * @param source - the command exactly as the caller sent it.
 * @returns the normalized text and its line mapping, or `undefined` when the source holds
 *   anything this scanner cannot decide.
 */
export function normalizeStatements(source: string): NormalizedStatements | undefined {
  // Conserve: every construct that can hide a `;`, span lines, or change what a line means.
  if (source.includes('#') || source.includes('`')) return undefined
  if (source.includes("@'") || source.includes('@"')) return undefined
  if (source.includes(';;')) return undefined

  const lines: string[] = []
  const originalLines: number[] = []
  let current = ''
  let sourceLine = 1
  let parens = 0
  let braces = 0
  let broke = false

  const endLine = (): void => {
    lines.push(current)
    originalLines.push(sourceLine)
    current = ''
  }

  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (character === '\n') {
      endLine()
      sourceLine += 1
      index += 1
      continue
    }
    if (character === '\r') {
      endLine()
      sourceLine += 1
      index += source[index + 1] === '\n' ? 2 : 1
      continue
    }
    if (character === "'") {
      // A single-quoted string: no escapes, and it must close on this line.
      let end = index + 1
      while (end < source.length && source[end] !== "'") {
        if (source[end] === '\n' || source[end] === '\r') return undefined
        end += 1
      }
      if (end >= source.length) return undefined
      current += source.slice(index, end + 1)
      index = end + 1
      continue
    }
    if (character === '"') {
      // A double-quoted string: backtick escapes, and it must close on this line.
      let end = index + 1
      let closed = false
      while (end < source.length) {
        if (source[end] === '`') {
          end += 2
          continue
        }
        if (source[end] === '"') {
          closed = true
          break
        }
        if (source[end] === '\n' || source[end] === '\r') return undefined
        end += 1
      }
      if (!closed) return undefined
      current += source.slice(index, end + 1)
      index = end + 1
      continue
    }
    if (character === '(') {
      parens += 1
    } else if (character === ')') {
      parens -= 1
      if (parens < 0) return undefined
    } else if (character === '{') {
      braces += 1
    } else if (character === '}') {
      braces -= 1
      if (braces < 0) return undefined
    } else if (character === ';' && parens === 0 && braces === 0) {
      current += ';'
      index += 1
      while (horizontal(source[index])) index += 1
      // The next statement starts a line of its own; a trailing `;` just ends the line.
      if (source.slice(index).trim().length > 0 || index < source.length) {
        endLine()
        broke = true
      }
      continue
    }
    current += character
    index += 1
  }
  endLine()
  if (parens !== 0 || braces !== 0) return undefined
  if (!broke) return undefined
  return { text: lines.join('\n'), originalLines }
}

/**
 * Relabel planned steps: `line` stays the ORIGINAL line for the card, `anchor` is the
 * normalized line the marker must be written on.
 * @param steps - steps planned against the normalized text.
 * @param normalized - the mapping `normalizeStatements` returned.
 * @returns the same steps with truthful line numbers and their anchors.
 */
export function relabelSteps(
  steps: readonly Step[],
  normalized: NormalizedStatements,
): readonly Step[] {
  return steps.map((step) => ({
    line: normalized.originalLines[step.line - 1] ?? step.line,
    text: step.text,
    anchor: step.line,
  }))
}

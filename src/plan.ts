/**
 * The one piece of step planning both parse-based planners share.
 *
 * A planner answers a different question per dialect — PowerShell's
 * `[Parser]::ParseInput` and tree-sitter's bash grammar have nothing in common
 * — but they agree on the SHAPE of the answer: a set of 1-based line numbers,
 * one per top-level statement. Turning that set into this plugin's `Step[]` is
 * therefore not dialect-specific, and it lives here so `./pwshtree.ts` and
 * `./bashtree.ts` cannot drift apart on the details that matter: deduplication
 * (a `;` chain puts two statements on one line), ordering, and the fact that a
 * line the source does not have is dropped rather than turned into an
 * out-of-range step.
 *
 * @module dsh-shell-progress/plan
 */

import type { Step } from './split.ts'

/**
 * Collapse statement start lines into steps, taking each step's text from the
 * source line it names.
 *
 * The parsers report one statement per statement, so `$a = 1; $b = 2` yields
 * two statements with the SAME start line, and the step model is line-based:
 * the lines are deduplicated and sorted, and a line this source does not have
 * is dropped rather than turned into an out-of-range step.
 * @param source - the command text.
 * @param lineNumbers - statement start lines, as the parser reported them.
 * @returns the steps, in source order.
 */
export function stepsAtLines(source: string, lineNumbers: readonly number[]): readonly Step[] {
  const sourceLines = source.split(/\r\n|\n|\r/)
  const steps: Step[] = []
  for (const line of [...new Set(lineNumbers)].sort((left, right) => left - right)) {
    const text = sourceLines[line - 1]
    if (text === undefined) continue
    steps.push({ line, text })
  }
  return steps
}

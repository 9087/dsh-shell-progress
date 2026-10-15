/**
 * One command line as highlighted runs.
 *
 * This lives in its own module because TWO views render the same command: the step
 * list's rows and the hover card a bar segment opens. They must agree character for
 * character, and the alternative — exporting it from either view — would make the two
 * import each other (`StepList` already imports `formatSeconds` from `ProgressBar`).
 *
 * @module dsh-shell-progress/client/command-text
 */

import type { ReactNode } from 'react'
import { highlightCommand } from './highlight.ts'

/**
 * A command line as highlighted runs, or as its own text when the tool's language is
 * unknown. Only the COMMAND is highlighted: a step's output is arbitrary terminal text
 * with no grammar, and colour that means nothing is worse than no colour.
 * @param text - the command.
 * @param toolName - the tool that ran it, which names the grammar.
 * @returns the nodes to render inside the line's `<pre>`.
 */
export function commandContent(text: string, toolName: string): ReactNode {
  const runs = highlightCommand(text, toolName)
  if (runs === undefined) return text
  return runs.map((run, index) => (
    // Index keys: the run list is positional and never reordered.
    <span key={index} style={run.style}>{run.text}</span>
  ))
}

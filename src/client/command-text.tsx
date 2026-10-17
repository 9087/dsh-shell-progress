/**
 * One command line as highlighted runs.
 *
 * This lives in its own module because TWO views render the same command: the step
 * list's rows and the hover card a bar segment opens. They must agree character for
 * character, and the alternative — exporting it from either view — would make the two
 * import each other (`StepList` already imports `formatSeconds` from `ProgressBar`).
 *
 * A STEP IS ONE LINE, but the text handed in is not always one line: a command that was
 * never split is reported as ONE step whose text is the WHOLE command, so the card has to
 * render every line of it. `highlightCommand` tokenises a single line (`highlight.ts` reads
 * `tokens[0]`), so the split happens here, and each line is highlighted and cached on its
 * own.
 *
 * @module dsh-shell-progress/client/command-text
 */

import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { highlightCommand } from './highlight.ts'

/**
 * One line as highlighted runs, or as its own text when the tool's language is unknown.
 * Only the COMMAND is highlighted: a step's output is arbitrary terminal text with no
 * grammar, and colour that means nothing is worse than no colour.
 * @param line - one line of the command.
 * @param toolName - the tool that ran it, which names the grammar.
 * @returns the nodes to render inside the line's `<pre>`.
 */
function lineContent(line: string, toolName: string): ReactNode {
  const runs = highlightCommand(line, toolName)
  if (runs === undefined) return line
  return runs.map((run, index) => (
    // Index keys: the run list is positional and never reordered.
    <span key={index} style={run.style}>{run.text}</span>
  ))
}

/**
 * A command as highlighted runs — every line of it.
 * @param text - the command; one line for an ordinary step, several for a command that was
 * never split.
 * @param toolName - the tool that ran it, which names the grammar.
 * @returns the nodes to render inside the line's `<pre>`.
 */
export function commandContent(text: string, toolName: string): ReactNode {
  const lines = text.split('\n')
  if (lines.length === 1) return lineContent(lines[0] ?? '', toolName)
  return lines.map((line, index) => (
    // Index keys: a command's lines are positional and never reordered.
    <Fragment key={index}>
      {index === 0 ? null : '\n'}
      {lineContent(line, toolName)}
    </Fragment>
  ))
}

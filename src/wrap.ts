/**
 * Display-only line breaks for a long one-line command.
 *
 * WHY THIS EXISTS. An agent often writes a whole pipeline as ONE line: `cd X; build;
 * echo; test; echo; report`. The planner is line-based on purpose (see `./plan`), so that
 * line is ONE step with ONE segment — correct, and useless to read: the hover card and the
 * step row then show a single enormous line that scrolls horizontally.
 *
 * WHAT THIS IS NOT. It is not a command splitter and never touches what runs. It inserts
 * newlines into a COPY of the step's text for display, at `;` boundaries that are provably
 * top-level (outside quotes, parentheses, braces and comments) and only for a line long
 * enough to be worth breaking. The persisted `text` stays byte-for-byte what was executed;
 * `displayText` is the same characters with newlines inserted, and the card prefers it only
 * for rendering.
 *
 * CONSERVATIVE ON PURPOSE. Anything the scanner cannot decide — an unterminated quote, a
 * here-string, a block comment, a line with `#` (which ends the statement list) — answers
 * "no display text", and the card keeps showing the single line. A wrong break would put a
 * `;` of a string literal at the start of a line and read as shell syntax, which is worse
 * than a long line.
 *
 * @module dsh-shell-progress/wrap
 */

/** Shorter than this and the line is already readable; do not reformat what needs no help. */
const MIN_LENGTH = 80

/**
 * Find the positions a top-level `;` ends at, scanning like `scanLine` does.
 * @param line - one source line.
 * @returns the break offsets (just past the `;` and any spaces after it), or undefined when
 *   the line holds a construct this scanner cannot decide.
 */
function breakPoints(line: string): number[] | undefined {
  const points: number[] = []
  let parens = 0
  let braces = 0
  let index = 0
  while (index < line.length) {
    const character = line[index]
    if (character === '#') return undefined
    if (character === "'") {
      index += 1
      while (index < line.length && line[index] !== "'") index += 1
      if (index >= line.length) return undefined
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
      if (!closed) return undefined
    } else if (character === '(') {
      parens += 1
    } else if (character === ')') {
      parens -= 1
    } else if (character === '{') {
      braces += 1
    } else if (character === '}') {
      braces -= 1
    } else if (character === ';' && parens === 0 && braces === 0) {
      let end = index + 1
      while (line[end] === ' ') end += 1
      points.push(end)
    }
    if (parens < 0 || braces < 0) return undefined
    index += 1
  }
  if (parens !== 0 || braces !== 0) return undefined
  // A trailing `;` would leave an empty line; the last break only counts when something
  // follows it.
  return points.filter((point) => line.slice(point).trim().length > 0)
}

/**
 * The step's text with display-only newlines at its top-level `;` boundaries.
 * @param text - the step's own text (one line, as executed).
 * @param minLength - the length at which reformatting is worth it.
 * @returns the text to render, or `undefined` when the single line should be shown as is.
 */
export function wrappedDisplayText(text: string, minLength: number = MIN_LENGTH): string | undefined {
  if (text.length < minLength || text.includes('\n')) return undefined
  // Here-strings and block comments span the whole construct; never reformat them.
  if (text.includes("@'") || text.includes('@"') || text.includes('<#') || text.includes('#>')) return undefined
  const points = breakPoints(text)
  if (points === undefined || points.length === 0) return undefined
  let out = ''
  let start = 0
  for (const point of points) {
    out += `${text.slice(start, point)}\n`
    start = point
  }
  out += text.slice(start)
  return out
}

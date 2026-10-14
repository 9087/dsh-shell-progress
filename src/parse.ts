/**
 * Turning a stream of output deltas into step switches and output lines.
 *
 * `readOutput()` hands back whatever arrived since the previous read, which
 * may end in the MIDDLE of a line. A marker mistaken for a partial line, or a
 * partial line mistaken for a marker, would silently mis-attribute output, so
 * the splitter keeps the trailing fragment until the next read completes it.
 *
 * @module dsh-shell-progress/parse
 */

import { markerPattern } from './instrument.ts'

/** One thing a delta turned out to say. */
export type StreamEvent =
  | { readonly kind: 'marker'; readonly line: number }
  | { readonly kind: 'text'; readonly text: string }

/**
 * A line-at-a-time reassembler over a stream of arbitrary deltas.
 *
 * Markers are always complete lines (`[Console]::Out.WriteLine` terminates
 * them), so a marker can only be recognised once its line is whole.
 */
export class LineFeeder {
  private rest = ''

  constructor(private readonly nonce: string) {}

  /**
   * Consume one delta, emitting an event per COMPLETE line and holding any
   * trailing fragment back.
   * @param delta - output produced since the previous read.
   * @returns the events this delta completed, in order.
   */
  feed(delta: string): StreamEvent[] {
    if (delta.length === 0) return []
    const data = this.rest + delta
    const parts = data.split('\n')
    this.rest = parts.pop() ?? ''
    return parts.map((part) => this.classify(part))
  }

  /**
   * Emit whatever is still held. Call once, after the process has exited: the
   * tail declares the stream finished, so a last line without a terminator is
   * a line like any other.
   * @returns the final event, or nothing when the buffer was empty.
   */
  flush(): StreamEvent[] {
    if (this.rest === '') return []
    const line = this.rest
    this.rest = ''
    return [this.classify(line)]
  }

  /** Classify one complete line, dropping the carriage return a CRLF stream leaves behind. */
  private classify(rawLine: string): StreamEvent {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const match = markerPattern(this.nonce).exec(line)
    if (match !== null) {
      const lineNumber = Number(match[1])
      if (Number.isInteger(lineNumber)) return { kind: 'marker', line: lineNumber }
    }
    return { kind: 'text', text: line }
  }
}

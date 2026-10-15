/**
 * The segmented progress bar.
 *
 * One segment per top-level step, drawn EQUALLY WIDE from the start (the split
 * happens before the command runs, so the total is known). Width is never
 * proportional to duration: unexecuted steps have no duration yet, so that
 * would make the layout jump and turn the bar into a flame chart. Filling by
 * completed-step count is what "progress bar" means.
 *
 * ## Where the hover card attaches
 *
 * The bar's markup is still plain: nothing sits between `.bar` and `.track` that could
 * collapse the width. Each segment's hover card wraps the BUTTON and nothing else —
 * not the track, not the bar.
 *
 * That distinction is the whole history of this file. The card used to wrap the TRACK,
 * and the track inside it is `flex: 1 1 auto; min-width: 0` over segments that are
 * `flex: 1 1 0; min-width: 0` — a combination whose width resolves to ZERO inside the
 * shrink-to-fit wrapper the card inserts. The card rendered, the counter said `4/4`,
 * and the bar was an invisible zero-width line with a blank row beneath it.
 *
 * The wrapper is still inserted — `HoverCard` renders its `anchor` inside a `<span>`
 * of its own — but a segment is a fixed-pixel flex item, so the wrapper can only ever
 * be the segment's width: `ProgressBar.module.css` gives it the segment's own box, and
 * the button fills it. It must keep a REAL box, because the card is positioned from that
 * wrapper's rect; taking it out of layout with `display: contents` leaves the card at the
 * top of the viewport with every width still correct. The card is measured against the
 * TRACK through `widthAnchorRef` rather than against the one segment it belongs to, and
 * `e2e/card.spec.ts` measures the segment widths, the seams and the card's distance from
 * its own segment for exactly these reasons.
 *
 * @module dsh-shell-progress/client/ProgressBar
 */

import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { HoverCard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProgressView, StepRow } from './model.ts'
import { commandContent } from './command-text.tsx'
import { segmentGeometry } from './geometry.ts'
import type { TrackGeometry } from './geometry.ts'
import styles from './ProgressBar.module.css'

/** Localized strings this bar renders. */
export interface ProgressBarLabels {
  /** Accessible name of one segment. */
  readonly stepLabel: (row: StepRow, total: number) => string
}

/** Lines of a step's output a hover card shows before it says how many it hid. */
const CARD_OUTPUT_LINES = 6

/** Characters of a step's output a hover card shows, across all of its lines. */
const CARD_OUTPUT_CHARS = 400

/**
 * The output a hover card shows for one step, or null when there is nothing to show.
 *
 * - EMPTY (or blank, or a lone trailing newline) output yields null: the card is the
 *   command line and nothing else, with no dangling blank line and no divider — a rule
 *   with nothing under it is a rule across nothing.
 * - LONG output is clamped to `CARD_OUTPUT_LINES` lines and `CARD_OUTPUT_CHARS`
 *   characters. A cut in the middle of the text ends it with `…`; dropped lines add a
 *   final `… N more lines`, so what is NOT shown is stated instead of silently missing.
 *   The expanded step list stays the full view.
 * @param output - the output that command produced.
 * @returns the lines to render, or null.
 */
export function cardOutput(output: string): string | null {
  // CRLF comes from Windows shells; a trailing newline is the shell's line
  // terminator rather than a line of output.
  const normalised = output.replace(/\r\n?/gu, '\n').replace(/^\n+|\n+$/gu, '')
  if (normalised === '') return null
  const cut = normalised.length > CARD_OUTPUT_CHARS
  const lines = (cut ? normalised.slice(0, CARD_OUTPUT_CHARS) : normalised).split('\n')
  const shown = lines.slice(0, CARD_OUTPUT_LINES)
  const hidden = lines.length - shown.length
  const body = cut ? `${shown.join('\n')}…` : shown.join('\n')
  return hidden === 0 ? body : `${body}\n… ${String(hidden)} more line${hidden === 1 ? '' : 's'}`
}

/**
 * One segment's hover card: the step's command line with its clock, a DIVIDER, then the
 * output that command produced.
 *
 * This is the shell's own `HoverCard` — the same primitive the session list's rows use,
 * so the two hovers are one object as far as the reader is concerned. Its `content` is a
 * `ReactNode`, which is what the previous `Tooltip` could not accept: its prop was
 * `label: string | (() => string)` and its bubble rendered that string as a single text
 * child. Two things follow from the node form, and both were asked for:
 *
 * - The divider is a REAL element (`<hr>`), not a run of box-drawing glyphs sized to
 *   the widest line the way a string bubble had to be.
 * - The command is SYNTAX-HIGHLIGHTED, exactly as it is in the step list: both render
 *   `commandContent`, which is why that helper lives in its own module.
 *
 * The output stays plain: it is arbitrary terminal text with no grammar, and colour
 * that means nothing is worse than no colour.
 *
 * The clock is a plain value here rather than the resolver the `Tooltip` needed. It
 * does not go stale: the card re-renders with its row on every progress tick, so a
 * running step's `[3s]` counts up while the pointer rests on it.
 * @param row - the step whose segment this card belongs to.
 * @param duration - the step's own clock, or null while it is still pending.
 * @param toolName - the tool that ran the command; it names the highlighting grammar.
 * @returns the card's content.
 */
export function stepCard(row: StepRow, duration: string | null, toolName: string): ReactNode {
  const output = cardOutput(row.output)
  return (
    <div className={styles.card} data-step-card="true">
      <div className={styles.cardCommand} data-card-command="true">
        {commandContent(row.text, toolName)}
        {duration === null ? null : <span className={styles.cardTime} data-card-time="true">[{duration}]</span>}
      </div>
      {output === null ? null : (
        <>
          <hr className={styles.cardRule} data-card-divider="true" />
          <pre className={styles.cardOutput} data-card-output="true">{output}</pre>
        </>
      )}
    </div>
  )
}

/**
 * Device-pixel-exact segmentation.
 *
 * A CSS `gap` plus `flex: 1 1 0` leaves every width fractional and asks the browser to
 * snap them. At a fractional device ratio — 125% Windows scaling is the common case —
 * the same 1px gap lands on one physical pixel here and on two a few pixels away, so
 * the seams look uneven and the bar reads as untidy.
 *
 * So the geometry is computed in DEVICE pixels and converted back: the track's device
 * width is split into whole-pixel segments separated by a whole-pixel seam. Every
 * segment edge then lands on a device pixel and every seam is exactly one physical
 * pixel wide, at any ratio.
 *
 * The arithmetic — including when to give up on seams altogether, because a bar with
 * enough steps would otherwise spend itself on separators — lives in `segmentGeometry`,
 * which is pure and unit-tested. This hook only measures and applies it.
 *
 * Returns null only when there is nothing to measure yet, so the CSS fallback (`flex`
 * plus `gap`) covers the first layout pass and a zero-width track.
 */
function useExactTrack(count: number) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [geometry, setGeometry] = useState<TrackGeometry | null>(null)

  useLayoutEffect(() => {
    const node = trackRef.current
    if (node === null || count === 0) {
      setGeometry(null)
      return
    }
    const measure = (): void => {
      const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
      const deviceWidth = Math.round(node.getBoundingClientRect().width * ratio)
      setGeometry(segmentGeometry(deviceWidth, count, ratio))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    // Zoom changes `devicePixelRatio` without necessarily changing the CSS width, and
    // a ResizeObserver alone would not fire for that.
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [count])

  return { trackRef, geometry }
}

/** One always-visible row: the bar itself and the running step's clock. */
export function ProgressBar({ view, toolName, labels, onHoverStep, linkedStep }: {
  view: ProgressView
  /**
   * The tool that ran these commands. Only the hover cards use it: it names the
   * grammar their command lines are highlighted in, exactly as in the step list.
   */
  toolName: string
  labels: ProgressBarLabels
  /**
   * Called with a segment's step index while the pointer is over it, and with
   * null when it leaves. The card uses this to POINT AT the matching line in the
   * step list, instead of repeating that line's source coordinate in the card.
   */
  onHoverStep?: (index: number | null) => void
  /**
   * The step the OTHER view is pointing at — the expanded list. Hovering either
   * side lights both, so the bar and the list read as one thing rather than as two
   * parallel displays a reader has to match up by eye.
   */
  linkedStep?: number | null
}): ReactNode {
  // Hooks run before the early returns below, and `view.steps` is empty for the other
  // two bar shapes, which is how the hook is told there is nothing to measure.
  const { trackRef, geometry } = useExactTrack(view.steps.length)

  if (view.bar === 'none') return null

  if (view.bar === 'solid') {
    const percent = view.total === 0 ? 0 : Math.round((view.done / view.total) * 100)
    return (
      <div className={styles.bar}>
        <div
          className={styles.solid}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={view.total}
          aria-valuenow={view.done}
        >
          <span className={styles.solidFill} style={{ width: `${String(percent)}%` }} />
        </div>
        </div>
    )
  }

  // The card's content is rebuilt on every render of this bar, and the bar re-renders
  // on every progress tick — so the clock inside a hovered card is the same number the
  // expanded list shows, without a second counter to keep in step. The step's output
  // rides BELOW that first line (see `stepCard`).
  const durationOf = (row: StepRow): string | null => row.phase === 'pending'
    ? null
    : formatSeconds(row.phase === 'running' ? view.currentElapsedMs : row.durationMs)

  return (
    <div className={styles.bar}>
      <div
        ref={trackRef}
        className={styles.track}
        style={geometry === null ? undefined : { gap: geometry.gap }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={view.total}
        aria-valuenow={view.done}
      >
        {view.steps.map((row, index) => (
          <span
            key={row.index}
            className={styles.segmentWrap}
            /*
             * `minWidth: 0` inline because the stylesheet keeps a 6px floor for the
             * fallback path, and a floor would defeat an exact 4-device-pixel segment
             * on a narrow bar.
             */
            style={geometry === null
              ? undefined
              : { flex: '0 0 auto', width: geometry.widths[index], minWidth: 0 }}
          >
            {/*
             * The shell's own `HoverCard` — the same primitive the session list's rows
             * use — not the `title` attribute: `title` draws the OS bubble in the OS
             * font after the OS delay, and no amount of CSS reaches it. Three of its
             * props matter here:
             *
             * - `anchor` is the segment BUTTON alone. `HoverCard` renders it inside a
             *   `<span>` it owns, and that span is a block-level flex item — which is
             *   why the stylesheet gives it the segment's own box, and the button fills
             *   it. The wrapper must never be allowed to size the segment: a
             *   shrink-to-fit wrapper around `flex: 1 1 0` segments is exactly what once
             *   collapsed this bar to zero width (see the module comment).
             * - `widthAnchorRef` is the TRACK, so the card is as wide as the bar the
             *   segment belongs to rather than as narrow as the one step. That is what
             *   gives the output room to read.
             * - `variant="preview"` is the session list's own treatment: above the
             *   anchor when there is room below, portaled to `document.body` so the
             *   transcript's scroller cannot clip it.
             */}
            <HoverCard
              anchor={(
                <button
                  type="button"
                  className={styles.segment}
                  data-phase={row.phase}
                  data-tone={row.tone}
                  data-linked={linkedStep === row.index ? 'true' : undefined}
                  aria-label={labels.stepLabel(row, view.total)}
                  onMouseEnter={() => { onHoverStep?.(row.index) }}
                  onMouseLeave={() => { onHoverStep?.(null) }}
                  onFocus={() => { onHoverStep?.(row.index) }}
                  onBlur={() => { onHoverStep?.(null) }}
                />
              )}
              content={stepCard(row, durationOf(row), toolName)}
              openDelayMs={120}
              variant="preview"
              widthAnchorRef={trackRef}
            />
          </span>
        ))}
      </div>
    </div>
  )
}

/** Whole seconds, so a stalled step's clock is readable at a glance. */
export function formatSeconds(milliseconds: number): string {
  return `${String(Math.max(0, Math.round(milliseconds / 1000)))}s`
}

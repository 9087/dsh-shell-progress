/**
 * The segmented progress bar.
 *
 * One segment per top-level step, drawn EQUALLY WIDE from the start (the split
 * happens before the command runs, so the total is known). Width is never
 * proportional to duration: unexecuted steps have no duration yet, so that
 * would make the layout jump and turn the bar into a flame chart. Filling by
 * completed-step count is what "progress bar" means.
 *
 * ## Why this markup carries no popover component
 *
 * It used to wrap the track in the shared `HoverCard` primitive. That wrapper
 * is a shrink-to-fit flex item, and the track inside it is
 * `flex: 1 1 auto; min-width: 0` over segments that are `flex: 1 1 0;
 * min-width: 0` — a combination whose width resolves to ZERO inside a
 * shrink-to-fit parent. The card rendered, the counter said `4/4`, and the bar
 * was an invisible zero-width line with a blank row beneath it.
 *
 * So the bar is now plain markup this file owns end to end: nothing between
 * `.bar` and `.track` that can collapse the width. Each segment keeps its own
 * accessible name and a native tooltip with its command line AND the output that
 * command produced (see `bubbleLabel`), and the expanded step list is the
 * full-width, always-readable view of the same information. A richer hover card
 * can come back once it is verified against a live shell.
 *
 * @module dsh-shell-progress/client/ProgressBar
 */

import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProgressView, StepRow } from './model.ts'
import { segmentGeometry } from './geometry.ts'
import type { TrackGeometry } from './geometry.ts'
import styles from './ProgressBar.module.css'

/** Localized strings this bar renders. */
export interface ProgressBarLabels {
  /** Accessible name of one segment. */
  readonly stepLabel: (row: StepRow, total: number) => string
}

/** Lines of a step's output a hover bubble shows before it says how many it hid. */
const BUBBLE_OUTPUT_LINES = 6

/** Characters of a step's output a hover bubble shows, across all of its lines. */
const BUBBLE_OUTPUT_CHARS = 400

/**
 * The glyph the bubble's command/output divider is drawn with: U+2500 BOX
 * DRAWINGS LIGHT HORIZONTAL.
 *
 * A divider between the command and the output is asked for, and the shell's
 * `Tooltip` cannot carry an element that would draw one. Its prop is
 * `label: string | (() => string)` — quoted from `Tooltip.d.ts` in
 * `@deepseek-ai/dsh-client-ui-primitives`, the platform module this file imports
 * — and its bubble renders the resolved value as a text child of a `<span>`, so
 * characters are the only markup a bubble can carry. A run of these glyphs is the
 * one thing in that alphabet that reads as the card's own hairline.
 *
 * The same restriction is why the bubble is NOT syntax-highlighted: a token span
 * is an element, and the prop takes none. The card body remains the one place a
 * command is highlighted (see `./highlight.ts`).
 */
const RULE = '\u2500'

/** Shortest rule, in glyphs: below this a run reads as a stray dash. */
const RULE_MIN = 8

/** Longest rule, in glyphs: past this the bubble stretches into a slab. */
const RULE_MAX = 48

/**
 * The bubble's divider: a rule as long as the widest line it separates.
 *
 * The bubble is `width: max-content`, so the rule is read against the lines above
 * and below it. Sizing it from the longest line — rather than as a constant — is
 * what keeps a short command's rule from running past it and a long one's from
 * stopping in the middle. A box-drawing glyph's advance is not exactly a
 * proportional letter's, so this is not a pixel-equality promise; the real ratio
 * is measured in `e2e/card.spec.ts`.
 * @param lines - the lines the rule sits between.
 * @returns one line of box-drawing glyphs.
 */
function divider(lines: readonly string[]): string {
  const widest = lines.reduce((max, line) => Math.max(max, line.length), 0)
  return RULE.repeat(Math.min(RULE_MAX, Math.max(RULE_MIN, widest)))
}

/**
 * The hover bubble's text for one step: its command line with the clock, a
 * divider, then the output that command produced.
 *
 * The bubble is the shell's `Tooltip`, whose bubble is `white-space: pre-line` with
 * `overflow-wrap: break-word` — so a `\n` here is a real line break, and the label
 * is a STRING rendered as a text child (React escapes it), never markup. Long,
 * empty and markup-bearing output are therefore handled by construction rather than
 * by hoping:
 *
 * - EMPTY (or blank, or a lone trailing newline) output adds nothing at all — no
 *   line, and no divider either: the bubble is the command line and nothing else,
 *   with no dangling blank line.
 * - LONG output is clamped to `BUBBLE_OUTPUT_LINES` lines and
 *   `BUBBLE_OUTPUT_CHARS` characters. A cut in the middle of the text ends it with
 *   `…`; dropped lines add a final `… N more lines`, so what is NOT shown is
 *   stated instead of silently missing. The expanded step list stays the full view.
 * - MARKUP CHARACTERS — `<`, `>`, `&` — are ordinary characters of a string child,
 *   so they render as themselves and cannot become elements.
 * - The DIVIDER between the command and the output is a run of box-drawing glyphs
 *   (see `RULE`), sized to the widest line shown. It is the one separator a string
 *   can carry; the card body deliberately has none (see `StepList.module.css`).
 * @param row - the step whose segment the bubble belongs to.
 * @param duration - the step's own clock, or null while it is still pending.
 * @returns the bubble's text.
 */
export function bubbleLabel(row: StepRow, duration: string | null): string {
  const command = duration === null ? row.text : `${row.text} [${duration}]`
  // CRLF comes from Windows shells; a trailing newline is the shell's line
  // terminator rather than a line of output, and a leading one only indents the
  // bubble's first line by nothing.
  const output = row.output.replace(/\r\n?/gu, '\n').replace(/^\n+|\n+$/gu, '')
  if (output === '') return command
  const cut = output.length > BUBBLE_OUTPUT_CHARS
  const lines = (cut ? output.slice(0, BUBBLE_OUTPUT_CHARS) : output).split('\n')
  const shown = lines.slice(0, BUBBLE_OUTPUT_LINES)
  const hidden = lines.length - shown.length
  const body = cut ? `${shown.join('\n')}…` : shown.join('\n')
  const more = hidden === 0 ? '' : `\n… ${String(hidden)} more line${hidden === 1 ? '' : 's'}`
  return `${command}\n${divider([command, ...shown])}\n${body}${more}`
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
export function ProgressBar({ view, labels, onHoverStep, linkedStep }: {
  view: ProgressView
  labels: ProgressBarLabels
  /**
   * Called with a segment's step index while the pointer is over it, and with
   * null when it leaves. The card uses this to POINT AT the matching line in the
   * step list, instead of repeating that line's source coordinate in a tooltip.
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

  // The bubble's text is a RESOLVER, evaluated when the bubble becomes visible, so
  // the clock inside it is the step's elapsed time AT THAT INSTANT — the same
  // number the expanded list shows, without a second counter to keep in step. The
  // step's output rides BELOW that first line (see `bubbleLabel`).
  const labelOf = (row: StepRow): string => {
    const duration = row.phase === 'pending'
      ? null
      : formatSeconds(row.phase === 'running' ? view.currentElapsedMs : row.durationMs)
    return bubbleLabel(row, duration)
  }

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
             * The shell's own `Tooltip`, not the `title` attribute: `title` draws
             * the OS bubble in the OS font after the OS delay, and no amount of CSS
             * reaches it. Two of its props matter here:
             *
             * - `children` is a single anchor that Tooltip CLONES and injects
             *   handlers into, so no extra box is inserted — a wrapper element is
             *   exactly what once collapsed this bar to zero width.
             * - `portal` puts the bubble under `document.body`, because the
             *   transcript's own scroller sets `overflow`, and a bubble rendered
             *   in place would be clipped by it.
             */}
            <Tooltip
              /*
               * `label` accepts a STRING OR A RESOLVER, and the resolver form is the
               * one that matters here: it is evaluated only while the bubble is
               * visible, so the `[2s]` it shows is the elapsed time at the moment of
               * hovering rather than the value frozen at the last render. What it
               * resolves to is `bubbleLabel`: that command line, a divider, then the
               * output the step produced underneath it. A string is all the prop
               * takes — see `RULE` — so the divider is a run of box-drawing glyphs
               * and nothing in the bubble, the command included, is highlighted.
               */
              label={() => labelOf(row)}
              side="top"
              delayMs={120}
              maxWidth={520}
              portal
            >
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
            </Tooltip>
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

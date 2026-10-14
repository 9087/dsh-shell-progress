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
 * accessible name and a native tooltip with its command line, and the expanded
 * step list is the full-width, always-readable view of the same information.
 * A richer hover card can come back once it is verified against a live shell.
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
  // number the expanded list shows, without a second counter to keep in step.
  const labelOf = (row: StepRow): string => {
    const duration = row.phase === 'pending'
      ? null
      : formatSeconds(row.phase === 'running' ? view.currentElapsedMs : row.durationMs)
    return duration === null ? row.text : `${row.text} [${duration}]`
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
               * hovering rather than the value frozen at the last render.
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

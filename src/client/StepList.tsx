/**
 * The step list: one row per top-level step, its command line and its output.
 *
 * A row is the command line with the time beside it, and then that step's output
 * underneath — ALWAYS, with nothing to open. What a command printed is part of the
 * record, not detail you have to ask for, so there is no disclosure here: the list
 * has no collapsed state and no control that could introduce one.
 *
 * The marker column at the left holds a DOT, one per row, whose colour is that
 * row's state. It is not a copy of the bar's palette: both read the same
 * `--step-state-*` names, declared once on the card (see `Row.module.css`), so a
 * dot and its segment cannot drift apart. The dot is 4px and round, and grows on
 * hover about its own centre — a transform, so nothing around it moves.
 *
 * The output below the command line starts on the command text's OWN column (no
 * indent of its own) and is dimmer than the command. No hairline separates the two
 * HERE: the divider lives in the segment's hover card instead, between the command
 * and the output there (see `stepCard` in `ProgressBar.tsx`). There is no hover FILL anywhere in the row: the row's answer to the
 * pointer is the dot's growth and the bar's segment lift, not a background.
 *
 * @module dsh-shell-progress/client/StepList
 */

import type { ReactNode } from 'react'
import { formatSeconds } from './ProgressBar.tsx'
import { commandContent } from './command-text.tsx'
import type { ProgressView, StepPhase, StepRow } from './model.ts'
import styles from './StepList.module.css'

/** Localized strings this list renders. */
export interface StepListLabels {
  /** Accessible name of one row. */
  readonly stepLabel: (row: StepRow, total: number) => string
  /** Label of a step's output block. */
  readonly outputLabel: string
  /**
   * Says what a truncated output cost: the count the per-step budget discarded.
   * Rendered AT the cut, under the output it belongs to.
   */
  readonly truncated: (chars: number) => string
  /** Label of the output produced before the first step. */
  readonly preambleLabel: string
  /** Shown when a step produced nothing. */
  readonly statusDone: string
  readonly statusRunning: string
  readonly statusPending: string
  readonly statusFailed: string
}

/**
 * Render one step's row.
 * @param props.row - the step.
 * @param props.total - how many steps the command has, for the accessible name.
 * @param props.liveElapsedMs - the running step's clock, read live by the caller
 * so a step in flight keeps counting in this list too.
 * @param props.hovered - true while the bar's segment for THIS step is hovered.
 * @param props.onHover - reports the pointed-at step upward, so the bar can answer.
 * @param props.labels - localized strings.
 * @param props.phaseText - the phase's localized name, announced instead of drawn.
 * @returns the row.
 */
function StepRowView({ row, total, toolName, liveElapsedMs, hovered, onHover, labels, phaseText }: {
  readonly row: StepRow
  readonly total: number
  /** The tool that ran this command; it names the highlighting grammar. */
  readonly toolName: string
  readonly liveElapsedMs: number
  readonly hovered: boolean
  readonly onHover: (index: number | null) => void
  readonly labels: StepListLabels
  readonly phaseText: string
}): ReactNode {
  // A running step has no finished duration yet, so its clock comes from the live
  // snapshot rather than from `durationMs` — otherwise the only row still moving
  // would be the one showing a stale number.
  const duration = row.phase === 'pending'
    ? null
    : formatSeconds(row.phase === 'running' ? liveElapsedMs : row.durationMs)
  const spoken = `${labels.stepLabel(row, total)}, ${phaseText}${duration === null ? '' : `, ${duration}`}`
  return (
    <div
      className={styles.row}
      data-phase={row.phase}
      // The phase picks the dot's colour; the tone picks which of the phase's
      // colours, exactly as it does on the bar. Both are attributes rather than
      // inline styles so the palette stays in the stylesheet it is shared from.
      data-tone={row.tone}
      data-step={row.index}
      data-hovered={hovered ? 'true' : undefined}
      aria-label={spoken}
      onMouseEnter={() => { onHover(row.index) }}
      onMouseLeave={() => { onHover(null) }}
    >
      {/*
       * The command line is not a hit target any more: there is no child to open,
       * so a click on it means nothing and the pointer stays a text cursor.
       */}
      <div className={styles.headline} data-headline="true">
        {/*
         * The dot sits in the marker column the disclosure triangle used to own,
         * at the same coordinates: the box is unchanged, so it lands beside the
         * FIRST line of the command whether or not the command wraps.
         */}
        <span className={styles.marker} data-marker="true" aria-hidden="true">
          <span className={styles.dot} data-dot="true" />
        </span>
        {/*
         * The command and its clock are ONE text flow, not two boxes. As a separate flex
         * item the clock was pushed to the container's edge: stranded far right of a short
         * command, and detached from the end of a wrapped one. Inside the flow it stays
         * glued to the last character the command occupies, the way a terminal would
         * append it — and it wraps with the text when the text wraps.
         */}
        <div className={styles.code} data-code="true">
          {commandContent(row.text, toolName)}
          {duration === null ? null : <span className={styles.time} data-time="true">[{duration}]</span>}
        </div>
      </div>
      {/*
       * The output block is rendered ONLY when the step actually printed something.
       * A `\n`-only output is a text node, so `:empty` does not match it, and the
       * block's own margin and padding then add a blank line under a step that
       * printed nothing — which is what happened before this guard. Nothing here
       * folds output that exists; it hides a box that has nothing to show.
       *
       * Nothing separates the two in this BODY: the hairline that used to sit above
       * the output is gone, and the divider now lives inside the segment's hover card,
       * between the command line and the output there (see `stepCard` in
       * `ProgressBar.tsx`). The dimmer colour is what tells them apart here.
       */}
      {row.output.trim() === '' ? null : (
        <pre className={styles.output} data-output="true" aria-label={labels.outputLabel}>{row.output}</pre>
      )}
      {/*
       * The cut, stated AT the cut. The host's per-step budget drops whole lines once
       * the step's output passes `maxStepOutputChars`, and the kept text alone cannot
       * say whether it is everything the step printed: a truncated step and a quiet one
       * look identical. This is the only place that difference is visible.
       */}
      {row.droppedChars === 0 ? null : (
        <p className={styles.truncated} data-truncated="true">{labels.truncated(row.droppedChars)}</p>
      )}
    </div>
  )
}

/** The body of the card: the preamble, then every step. */
export function StepList({ view, toolName, labels, hoveredIndex, onHoverStep }: {
  view: ProgressView
  /** The tool whose command this list belongs to; it names the grammar. */
  toolName: string
  labels: StepListLabels
  /** The step the bar is currently pointing at, or null. */
  hoveredIndex?: number | null
  /** Reported upward so the bar can highlight the matching segment. */
  onHoverStep?: (index: number | null) => void
}): ReactNode {
  if (view.steps.length === 0) return null

  const phaseText = (phase: StepPhase): string => phase === 'running'
    ? labels.statusRunning
    : phase === 'done'
      ? labels.statusDone
      : phase === 'failed'
        ? labels.statusFailed
        : labels.statusPending

  return (
    <div className={styles.list}>
      {view.preamble.length === 0 ? null : (
        <pre className={styles.preamble} aria-label={labels.preambleLabel}>{view.preamble}</pre>
      )}
      {view.steps.map((row) => (
        <StepRowView
          key={row.index}
          row={row}
          total={view.steps.length}
          toolName={toolName}
          liveElapsedMs={view.currentElapsedMs}
          hovered={hoveredIndex === row.index}
          onHover={(index) => { onHoverStep?.(index) }}
          labels={labels}
          phaseText={phaseText(row.phase)}
        />
      ))}
    </div>
  )
}

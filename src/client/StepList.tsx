/**
 * The step list, as a tree: one node per top-level step, with that step's output as a
 * CHILD node.
 *
 * A node is the command line with the time beside it. The output hangs under it,
 * closed by default, behind a `+`/`-` marker: the list is the record of what RAN, and
 * what a step printed is detail you ask for rather than detail that buries the next
 * command. A step that printed nothing shows no marker — but keeps the marker's width,
 * so every command still starts in the same column.
 *
 * The hover fill belongs to the command line alone, not to the node: with a child open,
 * a background covering the whole node would highlight output that the pointer is
 * nowhere near.
 *
 * @module dsh-shell-progress/client/StepList
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { formatSeconds } from './ProgressBar.tsx'
import { highlightCommand } from './highlight.ts'
import type { ProgressView, StepPhase, StepRow } from './model.ts'
import styles from './StepList.module.css'

/** Localized strings this list renders. */
export interface StepListLabels {
  /** Accessible name of one row. */
  readonly stepLabel: (row: StepRow, total: number) => string
  /** Label of a step's output block, and of the marker that opens it. */
  readonly outputLabel: string
  /** Label of the output produced before the first step. */
  readonly preambleLabel: string
  /** Shown when a step produced nothing. */
  readonly statusDone: string
  readonly statusRunning: string
  readonly statusPending: string
  readonly statusFailed: string
}

/**
 * A command line as highlighted runs, or as its own text when the tool's language is
 * unknown. Only the COMMAND is highlighted: a step's output is arbitrary terminal text
 * with no grammar, and colour that means nothing is worse than no colour.
 * @param text - the command.
 * @param toolName - the tool that ran it, which names the grammar.
 * @returns the nodes to render inside the line's `<pre>`.
 */
function commandContent(text: string, toolName: string): ReactNode {
  const runs = highlightCommand(text, toolName)
  if (runs === undefined) return text
  return runs.map((run, index) => (
    // Index keys: the run list is positional and never reordered.
    <span key={index} style={run.style}>{run.text}</span>
  ))
}

/**
 * Render one step's node.
 * @param props.row - the step.
 * @param props.total - how many steps the command has, for the accessible name.
 * @param props.liveElapsedMs - the running step's clock, read live by the caller
 * so a step in flight keeps counting in this list too.
 * @param props.hovered - true while the bar's segment for THIS step is hovered.
 * @param props.expanded - true while this node's output child is showing.
 * @param props.onHover - reports the pointed-at step upward, so the bar can answer.
 * @param props.onToggle - opens or closes this node's output child.
 * @param props.labels - localized strings.
 * @param props.phaseText - the phase's localized name, announced instead of drawn.
 * @returns the node.
 */
function StepRowView({ row, total, toolName, liveElapsedMs, hovered, expanded, onHover, onToggle, labels, phaseText }: {
  readonly row: StepRow
  readonly total: number
  /** The tool that ran this command; it names the highlighting grammar. */
  readonly toolName: string
  readonly liveElapsedMs: number
  readonly hovered: boolean
  readonly expanded: boolean
  readonly onHover: (index: number | null) => void
  readonly onToggle: (index: number) => void
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
  const hasOutput = row.output.length > 0
  const open = hasOutput && expanded
  return (
    <div
      className={styles.row}
      data-phase={row.phase}
      data-step={row.index}
      data-hovered={hovered ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
      data-toggleable={hasOutput ? 'true' : undefined}
      aria-label={spoken}
      onMouseEnter={() => { onHover(row.index) }}
      onMouseLeave={() => { onHover(null) }}
    >
      {/*
       * Points at the line the bar's hovered segment belongs to. It is absolutely
       * positioned into `.steps`'s own padding, so it consumes NO width and every
       * command line keeps the exact starting position it had before.
       */}
      <span className={styles.arrow} data-arrow="true" aria-hidden="true">&gt;</span>
      {/*
       * The whole command line is the hit target, because a one-character marker is a
       * small thing to ask anyone to hit. The marker stops the event so the two
       * handlers cannot both fire and cancel each other out.
       */}
      <div
        className={styles.headline}
        data-headline="true"
        onClick={hasOutput ? () => { onToggle(row.index) } : undefined}
      >
        {hasOutput ? (
          <button
            type="button"
            className={styles.toggle}
            data-toggle="true"
            aria-expanded={expanded}
            aria-label={labels.outputLabel}
            onClick={(event) => { event.stopPropagation(); onToggle(row.index) }}
          >
            {/* The triangle is DRAWN, not typed — see the note on `.caret`. */}
            <span className={styles.caret} aria-hidden="true" />
          </button>
        ) : (
          <span className={styles.toggleSpacer} data-toggle-spacer="true" aria-hidden="true" />
        )}
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
      {open ? (
        <pre className={styles.output} data-output="true" aria-label={labels.outputLabel}>{row.output}</pre>
      ) : null}
    </div>
  )
}

/** The expanded body of the card. */
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
  // Every node starts closed. Held here rather than in the card because it is the
  // list's own state: collapsing the card and opening it again resets the tree, which
  // is what "default collapsed" has to mean.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set<number>())

  if (view.steps.length === 0) return null

  const phaseText = (phase: StepPhase): string => phase === 'running'
    ? labels.statusRunning
    : phase === 'done'
      ? labels.statusDone
      : phase === 'failed'
        ? labels.statusFailed
        : labels.statusPending

  const toggle = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

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
          expanded={expanded.has(row.index)}
          onHover={(index) => { onHoverStep?.(index) }}
          onToggle={toggle}
          labels={labels}
          phaseText={phaseText(row.phase)}
        />
      ))}
    </div>
  )
}

/**
 * The tool-call row for `shell_progress`.
 *
 * The header is the shell's OWN disclosure component (`DisclosureRow` from
 * ui-primitives) rather than a hand-rolled one, so the chevron sits on the LEFT
 * at the shared 24px process height with the shell's hover treatment — a reader
 * who has seen any other tool card feels no change at all.
 *
 * Three things it deliberately does NOT do through that component:
 *
 * - The progress line is a SIBLING of the row, not its `collapsedContent`. That
 *   slot is documented as INLINE ("keeps `collapsedContent` inline while open"),
 *   so the bar was laid out beside the title instead of on its own line. The row
 *   renders the header; this card owns the column beneath it.
 * - The DESCRIPTION is the inline slot, where the shell puts a tool's summary —
 *   and the separator is a real element, not a `·` in a composed string. The
 *   shell's own separator is a 2×2px dot between 8px margins; two spaces around a
 *   middot is visibly narrower, which is what a reader notices as "not the same".
 * - The leading glyph is drawn here. The native command row shows a `>-` prompt,
 *   and ui-primitives exports no such inline icon — `PluginArtworkTerminal` is
 *   decorative artwork, not a 14px glyph. Drawing the two strokes in
 *   `currentColor` matches the native row and follows its hover colour.
 *
 * Both states read one normalized view (see `./model.ts`), built either from the
 * settled call's persisted metadata or, while the command runs, from the host's
 * live snapshot.
 *
 * @module dsh-shell-progress/client/Row
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { LiveSnapshot } from '../types.ts'
import { NS } from './locales.ts'
import { ProgressBar } from './ProgressBar.tsx'
import type { ProgressBarLabels } from './ProgressBar.tsx'
import { StepList } from './StepList.tsx'
import type { StepListLabels } from './StepList.tsx'
import { argsOf, isErrorBlock, isSettledBlock, metaOf, viewFromLive, viewFromSettled } from './model.ts'
import type { ProgressView } from './model.ts'
import type { ProgressSnapshot } from './store.ts'
import styles from './Row.module.css'

/** The native command row's `>-` prompt, drawn in `currentColor`. */
function PromptGlyph(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M3.2 3.8L6.2 7l-3 3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.2 10.2h2.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The registrant's business face.
 *
 * `hooks` is a map of OBSERVABLES only — the framework binds each one onto the
 * component props as a `use<Name>` selector hook. Anything that is not an
 * observable lives beside that compartment, which is why `watchCall` is a
 * sibling rather than a member of it.
 */
export interface ShellProgressFace {
  hooks: {
    /** Live progress per call id, polled by the store. */
    progress: HostObservable<ProgressSnapshot>
  }
  /**
   * Keep one call's progress fresh for as long as the returned disposer is
   * held. A side effect, not a subscription: the data channel is the hook
   * above, and components never wire their own subscriptions.
   */
  watchCall(callId: string): () => void
}

/** Full props of the registered row. */
export type ShellProgressRowProps =
  & ToolCallViewProps
  & PropsLocale<typeof NS>
  & InjectFace<ShellProgressFace>

/** The registered component. */
export function ShellProgressRow(props: ShellProgressRowProps): ReactNode {
  const { block, callId, toolName, t, useProgress, watchCall } = props
  const [open, setOpen] = useState(false)
  // Which step the pointer is on, from EITHER view. Held here because the bar and
  // the step list are separate components: hovering a segment lights the matching
  // line, hovering a line lights its segment, and the two read as one display.
  const [linkedStep, setLinkedStep] = useState<number | null>(null)

  const settled = isSettledBlock(block)
  const failed = isErrorBlock(block)
  const args = argsOf(block)
  const live = useProgress((snapshot: ProgressSnapshot) => snapshot.calls[callId])

  // Poll only while this call is in flight; the effect's cleanup stops it the
  // moment the settled block arrives. The `typeof` guard is not defensive
  // clutter: if the inject face ever stops delivering this member, the row would
  // otherwise do NOTHING, which looks exactly like a poll that finds no data —
  // and telling those two apart is what the probe line below is for.
  useEffect(() => {
    if (settled) return undefined
    if (typeof watchCall !== 'function') return undefined
    return watchCall(callId)
  }, [callId, settled, watchCall])

  const view: ProgressView = settled
    ? viewFromSettled(metaOf(block), failed)
    : viewFromLive(live as LiveSnapshot | undefined)

  const barLabels: ProgressBarLabels = {
    stepLabel: (row, total) => t('row.stepLabel', { index: row.index, total, line: row.line }),
    truncated: (chars) => t('row.truncated', { chars }),
  }
  const listLabels: StepListLabels = {
    stepLabel: (row, total) => t('row.stepLabel', { index: row.index, total, line: row.line }),
    outputLabel: t('row.output'),
    truncated: (chars) => t('row.truncated', { chars }),
    preambleLabel: t('row.preamble'),
    statusDone: t('status.done'),
    statusRunning: t('status.running'),
    statusPending: t('status.pending'),
    statusFailed: t('status.failed'),
  }

  // Both notices describe a SETTLED run: while a call is in flight the host may
  // simply not have answered yet, and claiming "ran unmodified" then would be
  // wrong.
  //
  // The unmodified notice hangs on the refusal FLAG, never on the step count. It
  // used to read `view.total > 1`, a proxy that held only while a refused command
  // still carried the heuristic's guessed steps: now that a refusal plans NO step
  // (a refusal is not a guess), such a card's total is 0 and a count would make
  // the notice disappear — silently, which is exactly the regression this flag
  // exists to prevent. `!view.instrumented` is kept beside it because the notice
  // claims the command ran unmodified, which cannot be true of an instrumented run.
  const notice = settled && view.refused && !view.instrumented
    ? t('row.notInstrumented')
    : settled && view.partial
      ? t('row.partial')
      : undefined


  return (
    <div className={styles.card}>
      <DisclosureRow
        icon={<PromptGlyph />}
        title={t('row.title', { tool: toolName })}
        open={open}
        expandable={view.total > 0}
        onToggle={() => { setOpen((previous) => !previous) }}
        running={view.running}
        expandOnRowClick
        previewChevron
        // The summary stays put when the row opens, exactly as the shell's own
        // tool rows keep theirs.
        keepContentWhenOpen
        collapsedContent={args.description === undefined ? undefined : (
          <>
            <span className={styles.sep} aria-hidden="true" />
            <span className={styles.summary}>{args.description}</span>
          </>
        )}
      />
      {/*
       * The progress line is rendered ONLY once the host has produced steps. With
       * none — a call whose live snapshot has not answered yet, or a settled
       * record that carries no step metadata — the card must show no bar and no
       * counter: an empty row would read as "progress is zero" rather than
       * "nothing is known yet". The card's own header above is what identifies
       * the call, and the shell renders the command line and the output.
       */}
      {view.total === 0 ? null : (
        <div className={styles.progressLine} data-progress-line="true">
          {/*
           * The counter TRAILS the bar, and it is the outermost element of the group:
           * bar first, count last, both centred on one line. The right edge the step
           * rows have to meet is therefore the COUNTER's, and it is the counter's own
           * box that ends on the shared `--card-pad-right`; the bar's right edge now
           * legitimately stops short of the rows by the counter's width and the row's
           * gap, which `e2e/card.spec.ts` measures rather than assumes.
           */}
          <ProgressBar
            view={view}
            toolName={toolName}
            labels={barLabels}
            onHoverStep={setLinkedStep}
            linkedStep={linkedStep}
          />
          <span className={styles.counter} data-counter="true">{t('row.counter', { done: view.done, total: view.total })}</span>
        </div>
      )}
      {notice === undefined ? null : <p className={styles.notice}>{notice}</p>}
      {/* The revealed detail scrolls on ITS OWN: the header and the bar above it
          are what the reader was already looking at, and dragging them out of
          view to reach step four is not what expanding a row should do. */}
      {open ? (
        <div className={styles.steps}>
          <StepList
            view={view}
            toolName={toolName}
            labels={listLabels}
            hoveredIndex={linkedStep}
            onHoverStep={setLinkedStep}
          />
        </div>
      ) : null}
    </div>
  )
}

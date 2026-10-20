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
import { DisclosureRow, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { LiveSnapshot, RefusalCode } from '../types.ts'
import { NS } from './locales.ts'
import { ProgressBar } from './ProgressBar.tsx'
import type { ProgressBarLabels } from './ProgressBar.tsx'
import { PlainBody, StepList } from './StepList.tsx'
import type { StepListLabels } from './StepList.tsx'
import { argsOf, formatTotal, isSettledBlock, metaOf, viewFromLive, viewFromSettled, withNotes } from './model.ts'
import type { ProgressView } from './model.ts'
import { markNotesAsked, notesAsked, rememberNotes, rememberedNotes } from './lazy-notes.ts'
import { notesEnabled } from './notes-preference.ts'
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
 * The `⚠` that marks a card whose command was not tracked.
 *
 * A refusal is not an error — the command ran, and ran unmodified — so the mark is the
 * system's warning AMBER as a plain triangle rather than a red badge, and it is centred
 * inside the header's line so it sits on the title's own axis. It is an ORDINARY tooltip,
 * not a hover card: the message is one sentence, so the shell's own bubble is the right
 * weight (and the segment's hover card next to it stays the only CARD in this plugin).
 * It stays a hand cursor — a mark that opens something is a thing to point at.
 * @param props.label - the explanation, in the reader's language.
 * @returns the mark and its tooltip.
 */
function UntrackedMark({ label }: { readonly label: string }): ReactNode {
  return (
    // The marker attribute lives on a plain wrapper, NOT on the tooltip's anchor: the shell's
    // `Tooltip` is a client-side surface (its bubble measures itself in the DOM), so a static
    // render keeps the wrapper and drops the anchor inside it. The card's own claim — "this
    // command was not tracked" — must survive that, which is what this wrapper is for.
    <span className={styles.untrackedAnchor} data-untracked="true">
      <Tooltip label={label} side="bottom" portal delayMs={120} maxWidth={360}>
        <span
          className={styles.untracked}
          aria-label={label}
          tabIndex={0}
        >{'\u26A0'}</span>
      </Tooltip>
    </span>
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
  /**
   * Ask the host to write notes for one card's step lines.
   *
   * Used by a card whose notes never arrived — the command ended before the model answered —
   * the first time the reader opens or hovers it. The host caches the answer per command, so
   * this costs a model call at most once per distinct command.
   * @param request - the step lines and the route the card was written with.
   * @returns one note per line, or `undefined` when the host could not write them.
   */
  notes(request: {
    readonly lines: readonly string[]
    readonly provider: string
    readonly model: string
  }): Promise<readonly (string | undefined)[] | undefined>
}

/** Full props of the registered row. */
export type ShellProgressRowProps =
  & ToolCallViewProps
  & PropsLocale<typeof NS>
  & InjectFace<ShellProgressFace>

/**
 * The `⚠` tooltip's sentence: what was not tracked, then WHY — in the reader's language.
 *
 * The host sends a CODE rather than the sentence it logged (see `RefusalCode`), because a
 * logged sentence would come back in whichever language the writing host used. An absent
 * code (an older record, or a host that did not say) leaves the generic sentence.
 * @param t - this namespace's translator.
 * @param code - why the command was refused, when the host said.
 * @returns the tooltip's text.
 */
function untrackedLabel(t: ShellProgressRowProps['t'], code: RefusalCode | undefined): string {
  if (code === undefined) return t('row.untracked')
  const reason = ((): string => {
    switch (code) {
      case 'block-comment': return t('row.reason.block-comment')
      case 'here-string': return t('row.reason.here-string')
      case 'line-continuation': return t('row.reason.line-continuation')
      case 'unterminated-quote': return t('row.reason.unterminated-quote')
      case 'unbalanced': return t('row.reason.unbalanced')
      case 'syntax-error': return t('row.reason.syntax-error')
      case 'no-answer': return t('row.reason.no-answer')
      case 'unsplittable': return t('row.reason.unsplittable')
      case 'too-many-steps': return t('row.reason.too-many-steps')
      case 'already-instrumented': return t('row.reason.already-instrumented')
      case 'reserved-variable': return t('row.reason.reserved-variable')
      case 'read-only': return t('row.reason.read-only')
    }
  })()
  return `${t('row.untracked')}${t('row.untracked.reason', { reason })}`
}

/** The registered component. */
export function ShellProgressRow(props: ShellProgressRowProps): ReactNode {
  const { block, callId, toolName, t, useProgress, watchCall, notes: fetchNotes } = props
  const [open, setOpen] = useState(false)
  // Which step the pointer is on, from EITHER view. Held here because the bar and
  // the step list are separate components: hovering a segment lights the matching
  // line, hovering a line lights its segment, and the two read as one display.
  const [linkedStep, setLinkedStep] = useState<number | null>(null)
  // Notes this card asked for itself, when its record carried none. Seeded from the page
  // cache so a re-mounted card never asks twice.
  const [lazyNotes, setLazyNotes] = useState<readonly (string | undefined)[] | undefined>(
    () => rememberedNotes(callId),
  )

  const settled = isSettledBlock(block)
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

  const recorded: ProgressView = settled
    ? viewFromSettled(metaOf(block))
    : viewFromLive(live as LiveSnapshot | undefined)
  const view: ProgressView = lazyNotes === undefined ? recorded : withNotes(recorded, lazyNotes)

  // THE LAZY NOTES. A card's notes are frozen when its command ends, so a command that
  // finishes before the model answers has none at all. The card therefore asks for them the
  // first time the reader actually looks at it — opened, or a segment hovered — and only
  // once: the host caches per command, this page caches per card, and a failure simply
  // leaves the card without notes rather than retrying behind the reader's back.
  useEffect(() => {
    if (lazyNotes !== undefined) return
    if (!open && linkedStep === null) return
    if (!notesEnabled()) return
    const route = recorded.notesRoute
    if (route === undefined) return
    if (!recorded.steps.some((step) => step.note === undefined)) return
    if (typeof fetchNotes !== 'function') return
    if (notesAsked(callId)) return
    const lines = recorded.steps.map((step) => step.text)
    if (lines.length === 0) return
    markNotesAsked(callId)
    void fetchNotes({ lines, provider: route.provider, model: route.model })
      .then((answer) => {
        if (answer === undefined) return
        rememberNotes(callId, answer)
        setLazyNotes(answer)
      })
      .catch(() => {
        // A note is a convenience; the card is complete without one.
      })
  }, [callId, fetchNotes, lazyNotes, linkedStep, open, recorded])

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
  }

  // The only notice left is about LOST OUTPUT. The refusal itself is now said twice: the
  // header carries a `!` whose hover card explains it, and its ONE step is the whole
  // command, so the card is shaped like any other. The plain body is kept for a record
  // whose step list is EMPTY — a refusal persisted by an older host, which has nothing to
  // draw a bar from.
  const notice = settled && view.partial ? t('row.partial') : undefined
  const plain = view.refused && view.total === 0


  return (
    <div className={styles.card}>
      <DisclosureRow
        icon={<PromptGlyph />}
        title={t('row.title', { tool: toolName })}
        open={open}
        expandable={view.total > 0 || plain}
        onToggle={() => { setOpen((previous) => !previous) }}
        running={view.running}
        expandOnRowClick
        previewChevron
        // The summary stays put when the row opens, exactly as the shell's own
        // tool rows keep theirs.
        keepContentWhenOpen
        collapsedContent={(
          <>
            {view.refused ? <UntrackedMark label={untrackedLabel(t, view.refusedReason)} /> : null}
            {args.description === undefined ? null : (
              <>
                <span className={styles.sep} aria-hidden="true" />
                <span className={styles.summary}>{args.description}</span>
              </>
            )}
            {/*
             * The command's TOTAL time, in the header row beside the description: live while
             * the command runs (the poll re-renders it) and frozen once it settles, when the
             * host's record carries the final number. Same colour and figures as the step
             * clocks, so the header and the list read as one family.
             */}
            {view.totalElapsedMs > 0 ? (
              <>
                <span className={styles.sep} aria-hidden="true" />
                <span
                  className={styles.total}
                  data-total="true"
                  title={t('row.total')}
                  aria-label={`${t('row.total')}: ${formatTotal(view.totalElapsedMs)}`}
                >
                  {formatTotal(view.totalElapsedMs)}
                </span>
              </>
            ) : null}
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
      {/* The lost-output notice. Its triangle is the refusal mark's OWN glyph (see
          `UntrackedMark`), carried WITHOUT a tooltip: the sentence is the whole message, so
          there is nothing left for a hover card to explain. The glyph is decorative here —
          the text states the fact — so it is hidden from assistive technology. */}
      {notice === undefined ? null : (
        <p className={styles.notice} data-lost-output="true">
          <span className={`${styles.untracked} ${styles.noticeMark}`} aria-hidden="true">{'\u26A0'}</span>{notice}
        </p>
      )}
      {/* The revealed detail scrolls on ITS OWN: the header and the bar above it
          are what the reader was already looking at, and dragging them out of
          view to reach step four is not what expanding a row should do. */}
      {open ? (
        <div className={styles.steps}>
          {plain ? (
            <PlainBody
              command={args.command}
              output={view.preamble}
              toolName={toolName}
              outputLabel={listLabels.outputLabel}
            />
          ) : (
            <StepList
              view={view}
              toolName={toolName}
              labels={listLabels}
              hoveredIndex={linkedStep}
              onHoverStep={setLinkedStep}
            />
          )}
        </div>
      ) : null}
    </div>
  )
}

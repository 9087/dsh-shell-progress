/**
 * The advisory notice: one line, after a native shell call, saying the same command has a
 * tool that renders for the user.
 *
 * WHY A NOTICE AND NOT A GATE. The model chooses between `pwsh` and `shell_progress_pwsh`
 * on every shell call, and the two are the same executor: the model-visible output is
 * byte-identical, so a wrong choice costs the USER the card, not the model its result.
 * Guidance (`./pwsh.ts`) states the rule once, at the top of the prompt; measured over two
 * days it did not move the choice at all — 131 background runs, none of them through this
 * plugin. A DENY would move it, but a denial is also a retry, an error the user sees, and a
 * judgment call this module cannot make (nothing in the arguments says whether the caller
 * consumes the raw bytes). A notice is the cheap middle: it cannot make anything worse (a
 * model that ignores it is where it started), it lands next to the decision instead of at
 * the top of a long context, and it is logged, so whether it works is measurable.
 *
 * The text deliberately names no parameter, no count and no feature: this module should not
 * need editing when the tools gain one. It states the fact the model must know (the other
 * tool exists, is the same executor, is the default), names the one exception, and points at
 * the tool descriptions for the details.
 *
 * WHEN. Two moments, and the only brake between them is time: the FIRST native call of an
 * agent (where a session anchors on a tool), and every RELAPSE — a native call that follows
 * a call through the progress tool — because a model that used the good tool and then went
 * back is the case worth saying anything about. One notice per hour per agent, and that is
 * the only limit: no count cap, no minimum run of calls, no feature condition. A model that
 * ignores one is exactly where it started; a model that keeps relapsing hears about it at
 * most once an hour.
 *
 * @module dsh-shell-progress/suggestion
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'shell-progress-suggestion': {
      kind: 'shell-progress-suggestion'
    } & ContextFormed
  }
}

/** One dialect's pair of tool names: the host's own, and this plugin's counterpart. */
export interface SuggestionPair {
  /** The native tool the host mounts, e.g. `pwsh`. */
  readonly native: string
  /** This plugin's tool for the same dialect, e.g. `shell_progress_pwsh`. */
  readonly progress: string
}

/** At most one notice per agent in this window: the only brake the design has. */
export const NOTICE_COOLDOWN_MS = 60 * 60 * 1000

/** The one-line account the transcript shows for a notice. */
const SUMMARY = 'shell_progress available for the same command'

/** One agent's tallies. */
interface NoticeState {
  /** Native calls this agent has made, ever. */
  native: number
  /** Calls through this plugin's tool, ever; 0 means the agent has never tried it. */
  progress: number
  /** Native calls since the last call through this plugin's tool. */
  sinceProgress: number
  /** When the last notice was sent, ms since the epoch; 0 means none yet. */
  lastNoticeAt: number
}

/**
 * The notice text. Deliberately feature-agnostic: it names the native tool, the progress
 * tool, the equal output, the default, and where the single exception is written down.
 * @param pair - the two tool names for this dialect.
 * @returns the model-facing sentence.
 */
export function noticeText(pair: SuggestionPair): string {
  return `You just ran this through \`${pair.native}\`. \`${pair.progress}\` is the same executor`
    + ' — same command, same output you receive — but the user gets a step list instead of one'
    + ` opaque block, so it is the default. The one exception, where \`${pair.native}\` stays`
    + ' correct because something other than you consumes its raw stdout byte-exactly, is'
    + ' spelled out in its description.'
}

/**
 * Attach a notice to a settled post-execute decision without disturbing what came before it.
 * @param decision - the downstream decision.
 * @param notice - the message to prepend to the next request's context.
 * @returns the decision carrying the notice.
 */
function withNotice(decision: PostToolDecision, notice: UserMessage): PostToolDecision {
  const additionalContexts = [notice, ...decision.additionalContexts ?? []]
  if (decision.kind === 'block') return { kind: 'block', feedback: decision.feedback, additionalContexts }
  return { ...decision, additionalContexts }
}

/**
 * Install the notice listener.
 * @param ctx - the plugin context; the listener is disposed with it.
 * @param pairs - every dialect this host exposes, with both tools' names.
 */
export function installNotice(ctx: Context, pairs: readonly SuggestionPair[]): void {
  const progressOf = new Map(pairs.map((pair) => [pair.native, pair.progress]))
  const natives = new Set(pairs.map((pair) => pair.progress))
  if (progressOf.size === 0) return

  /** One agent's tallies; an agentless dispatch shares the plugin context's own row. */
  const states = new WeakMap<object, NoticeState>()
  const stateOf = (owner: object): NoticeState => {
    const known = states.get(owner)
    if (known !== undefined) return known
    const created: NoticeState = { native: 0, progress: 0, sinceProgress: 0, lastNoticeAt: 0 }
    states.set(owner, created)
    return created
  }

  ctx.on('tools/post-execute', async (exec: ToolExecution, _result, next) => {
    const downstream = await next()
    // A nested dispatch answers a program, not the model's own tool choice: the card it
    // bypassed is the outer `run_code` card, so the notice would be about the wrong call.
    if (exec.parent !== undefined) return downstream
    const state = stateOf(exec.agent ?? ctx)
    if (natives.has(exec.name)) {
      state.progress += 1
      state.sinceProgress = 0
      return downstream
    }
    if (!progressOf.has(exec.name)) return downstream
    state.native += 1
    state.sinceProgress += 1
    // The two moments worth a word: the first native call of an agent that has never tried
    // the progress tool (where a session anchors), and a relapse into the native tool after
    // it HAS used it. Everything else is a session already on the right tool.
    const anchored = state.progress === 0 && state.native === 1
    const relapsed = state.progress > 0 && state.sinceProgress === 1
    if (!anchored && !relapsed) return downstream
    // The only brake: one notice per hour per agent.
    const now = Date.now()
    if (now - state.lastNoticeAt < NOTICE_COOLDOWN_MS) return downstream
    state.lastNoticeAt = now
    return withNotice(downstream, createUserMessage({
      content: [{ type: 'text', text: noticeText({ native: exec.name, progress: progressOf.get(exec.name) ?? exec.name }) }],
      source: { kind: 'shell-progress-suggestion', form: 'notice', summary: boundContextSummary(SUMMARY) },
    }))
  })
}

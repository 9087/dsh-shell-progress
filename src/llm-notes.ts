/**
 * One line of plain language per command line, written by the model.
 *
 * WHAT THIS IS FOR. The card's hover surface shows a step's command and the output it
 * produced; a reader who did not write the command has to work out what it does. A note
 * above the command answers that in one line, in the reader's own language.
 *
 * WHY IT IS SHAPED LIKE THIS.
 *
 * - **One call for the whole command, not one per step.** The steps are lines of a single
 *   script and the model needs them together to say anything useful about the sequence;
 *   one call also costs one latency instead of N.
 *
 * - **Structure, not imports.** The harness's own `GenerateOptions`/`StreamChunk` types
 *   live in `@deepseek-ai/dsh-llm`, which this plugin does not depend on. The pieces used
 *   here are declared structurally below, exactly as `ctx.get('sandboxPolicy')` is handled
 *   in `index.ts` — and a fake service is then trivially testable.
 *
 * - **Silence on ANY failure.** No service, no route, a refusal, a timeout, a malformed
 *   answer: the caller gets `undefined` and the card simply does not show the line. A note
 *   is a convenience; it must never be a reason the card is wrong, late, or loud about it.
 *
 * - **The chunk reading is deliberately tolerant.** Adapters differ in which field carries
 *   a text delta, and the cost of tolerating a shape that never arrives is nil, while the
 *   cost of insisting on one is silence on a host that spells it differently. `liveText`
 *   is the single place that reads them, so tightening it later is a one-line change.
 *
 * @module
 */

/** The slice of the harness LLM service this module uses. */
export interface LlmLike {
  /**
   * Stream one model request.
   * @param options - the fully assembled request.
   * @returns chunks in stream order.
   */
  stream(options: {
    readonly provider: string
    readonly model: string
    readonly system?: string
    readonly messages: readonly {
      readonly role: 'user' | 'assistant' | 'system'
      readonly content: readonly { readonly type: string; readonly text?: string }[]
    }[]
    readonly maxTokens?: number
    readonly signal?: AbortSignal
  }): AsyncIterable<unknown>
}

/** What the caller asks for. */
export interface StepNotesRequest {
  /** The LLM service, or `undefined` when the host does not provide one. */
  readonly llm: LlmLike | undefined
  /** The provider route the session's own requests use. */
  readonly provider: string
  /** The model route the session's own requests use. */
  readonly model: string
  /** The language the notes must be written in, as a BCP-47 tag. */
  readonly locale: string
  /** The command lines to describe, in order. */
  readonly lines: readonly string[]
  /** Cancels the call when the run ends or the plugin unloads. */
  readonly signal?: AbortSignal
  /** How long to wait before giving up. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/** A note is one short line; a slow model is worse than no note. */
export const DEFAULT_TIMEOUT_MS = 8_000

/** Long enough for a sentence, short enough that the answer cannot become an essay. */
export const MAX_NOTE_CHARS = 60

/** How many tokens the whole answer may take: one short line per command, plus slack. */
const MAX_ANSWER_TOKENS = 512

/**
 * The instruction. Written as a list of REQUIRED output properties because that is what
 * models follow most reliably: the count, the language, the length, and the absence of
 * decoration are each stated, and the only thing the answer may contain is the notes.
 * @param count - how many notes are wanted.
 * @param locale - the language the notes must be written in.
 * @returns the system prompt.
 */
function systemPrompt(count: number, locale: string): string {
  return [
    'You annotate shell commands for a non-expert reader.',
    `Write exactly ${String(count)} notes, one per command line, in the same order.`,
    `Write each note in the language identified by the BCP-47 tag "${locale}".`,
    `Each note is ONE line of at most ${String(MAX_NOTE_CHARS)} characters, plain language, no code,`,
    'no trailing period, no numbering, no bullets, no markdown, no blank lines.',
    'Say what the line does, not how it does it. Output the notes and nothing else.',
  ].join(' ')
}

/**
 * Read one chunk's text, whatever field the host's adapter put it in.
 * @param chunk - a chunk from the stream.
 * @returns its text, or `''` when the chunk carries none.
 */
function liveText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (typeof chunk !== 'object' || chunk === null) return ''
  const record = chunk as { readonly text?: unknown; readonly delta?: unknown; readonly content?: unknown }
  if (typeof record.text === 'string') return record.text
  const delta = record.delta as { readonly text?: unknown } | undefined
  if (typeof delta === 'object' && delta !== null && typeof delta.text === 'string') return delta.text
  const content = record.content as { readonly text?: unknown } | undefined
  if (typeof content === 'object' && content !== null && typeof content.text === 'string') return content.text
  return ''
}

/**
 * Turn the model's answer into notes: one per non-empty line, decoration removed.
 *
 * Numbering and bullets are stripped because models add them even when told not to, and a
 * leading "1. " in the card would be noise the reader did not ask for. Lines past the
 * expected count are dropped: the instruction said how many there are, and a model that
 * keeps going is inventing steps that do not exist.
 * @param answer - the model's full text.
 * @param count - how many notes were requested.
 * @returns the notes, possibly fewer than `count`.
 */
export function parseNotes(answer: string, count: number): readonly string[] {
  return answer
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, count)
    .map((line) => (line.length > MAX_NOTE_CHARS ? `${line.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…` : line))
}

/**
 * Ask the model for one note per command line.
 *
 * Never rejects and never throws: every failure — no service, an empty answer, a stream
 * that throws, a timeout — answers `undefined`, which the caller reads as "show nothing".
 * @param request - what to describe and which route to use.
 * @returns the notes in command-line order, or `undefined` when there are none to show.
 */
export async function requestStepNotes(request: StepNotesRequest): Promise<readonly string[] | undefined> {
  const { llm, lines, timeoutMs = DEFAULT_TIMEOUT_MS } = request
  if (llm === undefined || lines.length === 0) return undefined
  // The caller's own cancellation (the run ended) and the deadline both have to be able to
  // stop the call, so they are combined into the signal the stream is given.
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  request.signal?.addEventListener('abort', abort, { once: true })
  const deadline = setTimeout(abort, timeoutMs)
  try {
    const user = lines.map((line, index) => `${String(index + 1)}: ${line}`).join('\n')
    const stream = llm.stream({
      provider: request.provider,
      model: request.model,
      system: systemPrompt(lines.length, request.locale),
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: MAX_ANSWER_TOKENS,
      signal: controller.signal,
    })
    let answer = ''
    const consume = (async (): Promise<readonly string[]> => {
      for await (const chunk of stream) answer += liveText(chunk)
      return parseNotes(answer, lines.length)
    })()
    // ABORTING THE SIGNAL IS NOT ENOUGH ON ITS OWN: an adapter that ignores it would keep
    // the card waiting for a note nobody is going to see. The deadline therefore RACES the
    // stream, so the answer arrives on time whatever the stream does.
    const stopped = new Promise<undefined>((resolve) => {
      if (controller.signal.aborted) { resolve(undefined); return }
      controller.signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
    })
    const notes = await Promise.race([consume, stopped])
    if (notes === undefined) return undefined
    return notes.length === 0 ? undefined : notes
  } catch {
    return undefined
  } finally {
    clearTimeout(deadline)
    request.signal?.removeEventListener('abort', abort)
  }
}

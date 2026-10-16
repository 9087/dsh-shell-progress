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
 * The instruction.
 *
 * THE NUMBERING IS LOAD-BEARING, not decoration. The first version asked for the notes alone
 * and matched them to steps BY ORDER; a model that opened with "Let me go through each line:"
 * — and one did — had its own reasoning read as the first step's note, with every real note
 * landing one step too late. Requiring each answer line to carry the command's own number
 * means an answer that does not line up loses THAT note instead of shifting the rest: a
 * missing note costs a convenience, a misattributed one lies about what a command does.
 * @param count - how many notes are wanted.
 * @param locale - the language the notes must be written in.
 * @returns the system prompt.
 */
function systemPrompt(count: number, locale: string): string {
  return [
    'You annotate shell commands for a non-expert reader.',
    'The user sends numbered command lines. Answer with ONE line per command line, and start',
    'every answer line with that command line\'s OWN number followed by a colon, like "3: ...".',
    `Write each note in the language identified by the BCP-47 tag "${locale}".`,
    `Each note is at most ${String(MAX_NOTE_CHARS)} characters, plain language, no code, no markdown, no trailing period.`,
    'Do NOT repeat or paraphrase the code: the reader can already see that line, so name what it',
    'ACCOMPLISHES instead. Do not open with the command name, a file name, or a phrase like "this line".',
    `Answer with the ${String(count)} numbered lines and NOTHING else: no preamble, no reasoning,`,
    'no summary, no blank lines, no code fences. Say what the line does, not how it does it.',
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
 * Turn the model's answer into notes: one per NUMBERED line, matched to the command it names.
 *
 * Anything that is not a numbered line is IGNORED — a preamble, a recap, a code fence, a
 * stray bullet. An answer that skips a number leaves THAT step without a note and all the
 * others exactly where they belong; that is the whole reason the answer is numbered, and the
 * failure it prevents is not hypothetical: matching by position is how a model's own
 * reasoning once became step 1's note and pushed every real note one step late.
 * @param answer - the model's full text.
 * @param count - how many notes were requested.
 * @returns one entry per command line, `undefined` for a line the model did not name.
 */
export function parseNotes(answer: string, count: number): readonly (string | undefined)[] {
  const notes: (string | undefined)[] = []
  for (let index = 0; index < count; index += 1) notes.push(undefined)
  for (const line of answer.split('\n')) {
    // `1: …`, `1. …`, `1) …` — plus an optional comment marker the model may add anyway.
    const match = /^\s*(\d{1,4})\s*[:.)\]]\s*(.*)$/u.exec(line)
    if (match === null) continue
    const index = Number(match[1]) - 1
    const text = (match[2] ?? '').replace(/^\s*(?:#|\/\/)\s*/u, '').trim()
    if (index < 0 || index >= count || text.length === 0 || notes[index] !== undefined) continue
    notes[index] = text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…` : text
  }
  return notes
}

/**
 * Ask the model for one note per command line.
 *
 * Never rejects and never throws: every failure — no service, an empty answer, a stream
 * that throws, a timeout — answers `undefined`, which the caller reads as "show nothing".
 * @param request - what to describe and which route to use.
 * @returns the notes in command-line order, or `undefined` when there are none to show.
 */
export async function requestStepNotes(request: StepNotesRequest): Promise<readonly (string | undefined)[] | undefined> {
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
    const consume = (async (): Promise<readonly (string | undefined)[]> => {
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
    // Every step missing a note is the same answer as no notes at all: show nothing.
    return notes.some((note) => note !== undefined) ? notes : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(deadline)
    request.signal?.removeEventListener('abort', abort)
  }
}

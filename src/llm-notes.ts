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
    /**
     * The adapter-owned reasoning effort for this exact model.
     *
     * A note is one short line, so the notes request asks for `off`: the model's configured
     * effort (this host runs `high`) spends its whole budget — and many seconds — thinking
     * about a sentence the reader wants immediately, and with a small `maxTokens` the visible
     * answer can end up empty. The harness's own auxiliary calls (session titles) do the same.
     */
    readonly reasoningEffort?: string
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
  /**
   * Called ONCE with the reason the notes could not be written.
   *
   * A note is a convenience, so its absence is silent by design — but "silent" made a broken
   * call indistinguishable from a model that simply had nothing to say. The card records this
   * reason in its metadata, which is the only place a reader (or a maintainer) can look it up
   * without a host log.
   * @param reason - why no note was produced.
   */
  readonly onFailure?: (reason: NotesFailure) => void
}

/** Why a note request produced nothing. */
export type NotesFailure = 'aborted' | 'timeout' | 'threw' | 'empty'

/** A note is one short line; a slow model is worse than no note. */
export const DEFAULT_TIMEOUT_MS = 20_000

/** Long enough for a sentence, short enough that the answer cannot become an essay. */
export const MAX_NOTE_CHARS = 60

/** How many tokens the whole answer may take: one short line per command, plus slack. */
const MAX_ANSWER_TOKENS = 1_024

/**
 * The instruction.
 *
 * THE NUMBERING IS LOAD-BEARING, not decoration. The first version asked for the notes alone
 * and matched them to steps BY ORDER; a model that opened with "Let me go through each line:"
 * — and one did — had its own reasoning read as the first step's note, with every real note
 * landing one step too late. Requiring each answer line to carry the command's own number
 * means an answer that does not line up loses THAT note instead of shifting the rest: a
 * missing note costs a convenience, a misattributed one lies about what a command does.
 *
 * TWO RULES THAT ARE ABOUT THE READER, not the model's style. (1) ONE language for the whole
 * answer: asked merely to write "in" a language, an answer came back with its first line in
 * English and the rest in Chinese, which reads as two different annotators. (2) The command's
 * own strings stay VERBATIM — a printed message, a flag, a path — because a translated string
 * no longer matches what the reader will see in the output. Naming both explicitly is the
 * only way to get them consistently; the model otherwise treats them as a judgement call.
 * @param count - how many notes are wanted.
 * @param locale - the language the notes must be written in.
 * @returns the system prompt.
 */
function systemPrompt(count: number, locale: string): string {
  return [
    'You annotate shell commands for a non-expert reader.',
    'The user sends numbered command lines. Answer with ONE line per command line, and start',
    'every answer line with that command line\'s OWN number followed by a colon, like "3: ...".',
    `Write EVERY note in the language identified by the BCP-47 tag "${locale}" — that one`,
    'language for the whole answer. Never answer some lines in one language and the rest in another.',
    'Keep the command\'s own text verbatim: its command names, flags, paths, identifiers and any',
    'string it prints, matches or passes stay exactly as written in the command, untranslated.',
    `Each note is at most ${String(MAX_NOTE_CHARS)} characters, plain language, no markdown, no trailing period.`,
    'Do NOT repeat or paraphrase the code: the reader can already see that line, so name what it',
    'ACCOMPLISHES instead. Do not open with the command name, a file name, or a phrase like "this line".',
    `Answer with the ${String(count)} numbered lines and NOTHING else: no preamble, no reasoning,`,
    'no summary, no blank lines, no code fences. Say what the line does, not how it does it.',
  ].join(' ')
}

/**
 * Read one chunk's text, whatever field the host's adapter put it in.
 *
 * ONLY VISIBLE TEXT. The adapter's protocol carries `text-delta` and `reasoning-delta` chunks
 * with the SAME `text` field, so a reader that ignores the type concatenates the model's own
 * thinking into the answer: the reasoning is far longer than the notes, may contain
 * numbered-looking lines, and — on a host whose configured effort is `high` — is most of what
 * the model spends. A note must be the answer, never the deliberation.
 * @param chunk - a chunk from the stream.
 * @returns its text, or `''` when the chunk carries none.
 */
function liveText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (typeof chunk !== 'object' || chunk === null) return ''
  const record = chunk as {
    readonly type?: unknown
    readonly text?: unknown
    readonly delta?: unknown
    readonly content?: unknown
  }
  // Reasoning is explicitly NOT text for this purpose — see the doc comment.
  if (record.type === 'reasoning-delta') return ''
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
  const { llm, lines, timeoutMs = DEFAULT_TIMEOUT_MS, onFailure } = request
  if (llm === undefined || lines.length === 0) return undefined
  // A run that has ALREADY ended must not make a request: an AbortSignal that was aborted
  // before a listener was attached never fires that listener, so this is checked explicitly.
  if (request.signal?.aborted === true) {
    onFailure?.('aborted')
    return undefined
  }
  // The caller's own cancellation (the run ended) and the deadline both have to be able to
  // stop the call, so they are combined into the signal the stream is given. WHICH one fired
  // is tracked, because it is the only clue a reader gets when a card shows no note.
  const controller = new AbortController()
  let externalAbort = false
  let deadlineHit = false
  const stopExternal = (): void => {
    externalAbort = true
    controller.abort()
  }
  request.signal?.addEventListener('abort', stopExternal, { once: true })
  const deadline = setTimeout(() => {
    deadlineHit = true
    controller.abort()
  }, timeoutMs)
  try {
    const user = lines.map((line, index) => `${String(index + 1)}: ${line}`).join('\n')
    const stream = llm.stream({
      provider: request.provider,
      model: request.model,
      system: systemPrompt(lines.length, request.locale),
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: MAX_ANSWER_TOKENS,
      // A note is one sentence: thinking about it costs seconds and the answer's budget.
      reasoningEffort: 'off',
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
    if (notes === undefined) {
      onFailure?.(externalAbort ? 'aborted' : deadlineHit ? 'timeout' : 'aborted')
      return undefined
    }
    // Every step missing a note is the same answer as no notes at all: show nothing.
    if (!notes.some((note) => note !== undefined)) {
      onFailure?.('empty')
      return undefined
    }
    return notes
  } catch {
    onFailure?.('threw')
    return undefined
  } finally {
    clearTimeout(deadline)
    request.signal?.removeEventListener('abort', stopExternal)
  }
}

/**
 * One command's notes, kept so the SAME command is never described twice.
 *
 * A reader runs the same handful of commands all day (`pnpm test`, `git status`, a build
 * script), and each one would otherwise pay a model call. The key is the command itself plus
 * the language and the model that wrote it, so a language switch is a MISS rather than a
 * reused sentence in the wrong language.
 */
export interface NotesCache {
  /**
   * Read one cached set.
   * @param key - the key {@link notesKey} built.
   * @returns the notes, or `undefined` when nothing is cached.
   */
  get(key: string): readonly (string | undefined)[] | undefined
  /**
   * Remember one set, evicting the least recently used past the cap.
   * @param key - the key {@link notesKey} built.
   * @param notes - the notes to keep.
   */
  set(key: string, notes: readonly (string | undefined)[]): void
}

/**
 * The key one note set is cached under.
 *
 * The command lines are joined with a NUL, which a shell line cannot contain, so two
 * different commands can never share a key; the locale and model lead so a human reading a
 * key with a debugger sees the two things that make it language-specific first.
 * @param lines - the command's step lines, in order.
 * @param locale - the language the notes were written in.
 * @param provider - the provider that wrote them.
 * @param model - the model that wrote them.
 * @returns the cache key.
 */
export function notesKey(lines: readonly string[], locale: string, provider: string, model: string): string {
  return [locale, provider, model, ...lines].join('\u0000')
}

/** How many note sets a host keeps before evicting. */
const NOTES_CACHE_MAX = 200

/**
 * Create the notes cache: a small LRU, because an unbounded one would grow with every
 * command a long session runs.
 * @param max - how many sets to keep; the least recently read is evicted first.
 * @returns the cache.
 */
export function createNotesCache(max: number = NOTES_CACHE_MAX): NotesCache {
  const entries = new Map<string, readonly (string | undefined)[]>()
  return {
    get(key) {
      const hit = entries.get(key)
      if (hit === undefined) return undefined
      // Re-insert: `Map` iterates in insertion order, so the FIRST key is the one to evict.
      entries.delete(key)
      entries.set(key, hit)
      return hit
    },
    set(key, notes) {
      entries.delete(key)
      entries.set(key, notes)
      while (entries.size > max) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
  }
}

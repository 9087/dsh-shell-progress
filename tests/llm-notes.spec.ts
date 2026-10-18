/**
 * The notes module, against fake services.
 *
 * Everything here is about what the reader ends up SEEING, because the module's whole
 * contract is "a note, or nothing at all": the cases that matter are the ones where a
 * host has no service, no route, a slow model, a failing model, or an answer that needs
 * cleaning up before it can be shown.
 */
import { describe, expect, it, vi } from 'vitest'
import { createNotesCache, MAX_NOTE_CHARS, notesKey, parseNotes, requestStepNotes, type LlmLike } from '../src/llm-notes.ts'

/** A service that streams the given chunks and records the request it was given. */
function fakeLlm(chunks: readonly unknown[] | (() => AsyncIterable<unknown>)): {
  readonly llm: LlmLike
  readonly calls: { provider: string; model: string; system?: string; messages: readonly unknown[] }[]
} {
  const calls: { provider: string; model: string; system?: string; messages: readonly unknown[] }[] = []
  const llm: LlmLike = {
    stream(options) {
      calls.push({
        provider: options.provider,
        model: options.model,
        ...(options.system === undefined ? {} : { system: options.system }),
        messages: options.messages,
      })
      if (typeof chunks === 'function') return chunks()
      return (async function* generate() {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
  return { llm, calls }
}

const base = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  locale: 'zh-CN',
  lines: ['pnpm install', 'pnpm run build'],
}

describe('requestStepNotes', () => {
  it('returns one note per command line, in order', async () => {
    const { llm, calls } = fakeLlm([{ type: 'text', text: '1: 安装依赖\n2: 构建产物' }])
    const notes = await requestStepNotes({ ...base, llm })
    expect(notes).toEqual(['安装依赖', '构建产物'])
    expect(calls[0]?.provider).toBe('deepseek')
    expect(calls[0]?.model).toBe('deepseek-chat')
  })

  it('asks for the caller\u2019s language and for exactly as many notes as there are lines', async () => {
    const { llm, calls } = fakeLlm([{ type: 'text', text: 'a\nb' }])
    await requestStepNotes({ ...base, llm })
    const system = calls[0]?.system ?? ''
    expect(system, 'the locale is not stated to the model').toContain('zh-CN')
    expect(system, 'the note count is not stated to the model').toContain('2 numbered lines')
    expect(system, 'the length limit is not stated to the model').toContain(String(MAX_NOTE_CHARS))
    expect(system, 'the model is not told to stop restating the code it is annotating').toContain('Do NOT repeat or paraphrase the code')
    expect(system, 'the model is not told to number its answer').toContain('OWN number')
    // ONE language for the whole answer. Asked merely to write "in" a language, an answer came
    // back with its first line in English and the rest in Chinese — two annotators on one card.
    expect(system, 'the model is not told to keep one language for the whole answer').toContain('Never answer some lines in one language')
    // The command's own strings stay VERBATIM: a translated message stops matching the
    // output the reader is looking at.
    expect(system, 'the model is not told to keep the command\'s strings verbatim').toContain('untranslated')
  })

  it('hands the model the command lines themselves', async () => {
    const { llm, calls } = fakeLlm([{ type: 'text', text: '1: a\n2: b' }])
    await requestStepNotes({ ...base, llm })
    const sent = JSON.stringify(calls[0]?.messages ?? [])
    expect(sent, 'the first command is not in the request').toContain('pnpm install')
    expect(sent, 'the second command is not in the request').toContain('pnpm run build')
  })

  it('joins an answer that arrives in several chunks', async () => {
    const { llm } = fakeLlm([{ text: '1: 安装' }, { delta: { text: '依赖\n2: 构建' } }, { text: '产物' }])
    expect(await requestStepNotes({ ...base, llm })).toEqual(['安装依赖', '构建产物'])
  })

  it('takes the notes by their numbers and ignores every unnumbered line', () => {
    // The real answer that started this: a preamble, a recap, numbered notes. Matching by
    // POSITION read the preamble as step 1's note and pushed every note one step late.
    const answer = [
      'We need to write 2 notes in Chinese, one per command line.',
      'Let me go through each line:',
      '1: 安装依赖',
      '- 这一行没有编号，必须被忽略',
      '2: 构建产物',
      'Hope this helps!',
    ].join('\n')
    expect(parseNotes(answer, 2)).toEqual(['安装依赖', '构建产物'])
  })

  it('leaves THAT step empty when the model skips its number, instead of shifting the rest', () => {
    expect(parseNotes('1: 安装依赖\n3: 打包', 3)).toEqual(['安装依赖', undefined, '打包'])
  })

  it('strips a comment marker the model added anyway', () => {
    expect(parseNotes('1: # 安装依赖', 1)).toEqual(['安装依赖'])
  })

  it('drops a number past the expected count rather than inventing steps', () => {
    expect(parseNotes('1: a\n2: b\n3: c', 2)).toEqual(['a', 'b'])
  })

  it('truncates a note that ran long instead of letting it wrap', () => {
    const long = 'x'.repeat(MAX_NOTE_CHARS + 20)
    const [note] = parseNotes(`1: ${long}`, 1)
    expect(note?.length).toBe(MAX_NOTE_CHARS)
    expect(note?.endsWith('\u2026')).toBe(true)
  })

  it('shows NOTHING when the host has no llm service', async () => {
    expect(await requestStepNotes({ ...base, llm: undefined })).toBeUndefined()
  })

  it('shows nothing when there is nothing to describe', async () => {
    const { llm, calls } = fakeLlm([{ text: 'a' }])
    expect(await requestStepNotes({ ...base, llm, lines: [] })).toBeUndefined()
    expect(calls, 'a call was made for an empty command').toHaveLength(0)
  })

  it('shows nothing when the model fails, and does not throw', async () => {
    const { llm } = fakeLlm(() => (async function* generate() { throw new Error('boom') })())
    expect(await requestStepNotes({ ...base, llm })).toBeUndefined()
  })

  it('shows nothing when the model answers nothing', async () => {
    const { llm } = fakeLlm([{ text: '   \n\n' }])
    expect(await requestStepNotes({ ...base, llm })).toBeUndefined()
  })

  it('gives up on its own deadline instead of holding the card', async () => {
    vi.useFakeTimers()
    try {
      const { llm } = fakeLlm(() => (async function* generate() {
        await new Promise((resolve) => { setTimeout(resolve, 60_000) })
        yield { text: 'too late' }
      })())
      const pending = requestStepNotes({ ...base, llm, timeoutMs: 50 })
      await vi.advanceTimersByTimeAsync(100)
      expect(await pending).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

/** The request shape, for the assertion above that only needs to read it. */
interface StepNotesRequestShape {
  readonly lines: readonly string[]
}

describe('the notes cache', () => {
  it('keys by the command, the language AND the model that wrote it', () => {
    const base = notesKey(['pnpm test'], 'zh-CN', 'deepseek', 'deepseek-chat')
    expect(notesKey(['pnpm test'], 'zh-CN', 'deepseek', 'deepseek-chat')).toBe(base)
    // A language switch must MISS: the cached sentence is in the old language.
    expect(notesKey(['pnpm test'], 'en', 'deepseek', 'deepseek-chat')).not.toBe(base)
    // A different model may have written a different note.
    expect(notesKey(['pnpm test'], 'zh-CN', 'deepseek', 'deepseek-flash')).not.toBe(base)
    // Different commands never collide, even when one is a prefix of the other.
    expect(notesKey(['pnpm test'], 'zh-CN', 'deepseek', 'deepseek-chat')).not.toBe(
      notesKey(['pnpm test', 'pnpm build'], 'zh-CN', 'deepseek', 'deepseek-chat'),
    )
  })

  it('returns what it kept, and evicts the least recently USED past the cap', () => {
    const cache = createNotesCache(2)
    cache.set('a', ['first'])
    cache.set('b', ['second'])
    expect(cache.get('a')).toEqual(['first'])
    // Reading `a` makes `b` the least recently used, so the next insert evicts `b`.
    cache.set('c', ['third'])
    expect(cache.get('a')).toEqual(['first'])
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toEqual(['third'])
  })

  it('has nothing for a command it never saw', () => {
    expect(createNotesCache().get('unknown')).toBeUndefined()
  })
})

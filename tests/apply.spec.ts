/**
 * `apply` against a context that enforces cordis's inject rule.
 *
 * This suite exists because the plugin shipped a load-time failure that every
 * other test passed straight through: `apply` read `ctx.connection` as a
 * PROPERTY without declaring it in `inject`, and cordis's runtime getter guard
 * throws for exactly that — `cannot get property "connection" without inject` —
 * during `apply`, so the whole plugin tree failed and NO tool was registered.
 * Types cannot catch it (a cast silences the compiler) and the pure-function
 * suites never run `apply` at all.
 *
 * So this fake context reproduces the rule: the services listed in
 * {@link KNOWN_SERVICES} are present, and reading one whose name the plugin did
 * not declare through `inject` (static or dynamic) throws the same error.
 */

import { describe, expect, it, vi } from 'vitest'
import { apply, inject as declaredInject } from '../src/index.ts'
import { PROGRESS_CHANNEL, TOOL_NAME_BASH, TOOL_NAME_PWSH } from '../src/types.ts'

/** Service names the fake context hosts; an undeclared read of any of them throws. */
const KNOWN_SERVICES = ['tools', 'shell', 'shellEnv', 'connection', 'systemPrompt', 'sandboxPolicy']

interface Section {
  readonly name: string
  readonly order: number
  readonly text: string
}

/** One event listener the plugin registered; only `tools/post-execute` is exercised here. */
type Listener = (
  exec: { readonly name: string; readonly parent?: unknown; readonly agent?: object },
  result: unknown,
  next: () => Promise<unknown>,
) => Promise<unknown>

/** A context good enough for `apply`, with cordis's inject guard reproduced. */
function fakeContext(options: { readonly connection?: unknown; readonly llm?: unknown; readonly jobs?: unknown } = {}): {
  readonly ctx: unknown
  readonly registered: { readonly name: string; readonly output: unknown }[]
  readonly sections: Section[]
  readonly channels: string[]
  readonly handlers: unknown[]
  readonly dynamicInjections: string[][]
  readonly listeners: { readonly event: string; readonly handler: Listener }[]
} {
  const registered: { name: string; output: unknown }[] = []
  const sections: Section[] = []
  const channels: string[] = []
  const handlers: unknown[] = []
  const dynamicInjections: string[][] = []
  const listeners: { event: string; handler: Listener }[] = []
  const declared = new Set<string>(declaredInject)

  const base: Record<string, unknown> = {
    llm: options.llm,
    // The job registry, when the test mounts one. Read through `ctx.get`, so it is not in
    // `KNOWN_SERVICES`: an absent registry is a host that simply has none, not a bug.
    jobs: options.jobs,
    tools: {
      register: (definition: { name: string; output: unknown }) => {
        registered.push(definition)
        return () => {}
      },
    },
    shell: {
      sandboxMode: undefined,
      resolve: () => ({}),
      execute: async () => {
        throw new Error('execute is not exercised by this suite')
      },
    },
    shellEnv: { collect: () => ({}) },
    connection: options.connection,
    systemPrompt: {
      section: (section: Section) => {
        sections.push(section)
        return () => {}
      },
      // The real service places shell-tool guidance at TOOL_PWSH (1010).
      getSectionOrder: () => 1010,
    },
    logger: { debug: () => {}, warn: () => {} },
    on: (event: string, handler: unknown) => {
      listeners.push({ event, handler: handler as Listener })
      return () => {}
    },
    effect: (fn: () => unknown) => fn(),
    inject: (deps: string[], callback: (ctx: unknown) => unknown) => {
      for (const dep of deps) declared.add(dep)
      dynamicInjections.push([...deps])
      return callback(ctx)
    },
    get: (name: string) => base[name],
  }

  const ctx = new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && KNOWN_SERVICES.includes(property) && !declared.has(property)) {
        // The exact wording cordis uses, so a regression reads the same as the
        // real failure did.
        throw new Error(`cannot get property "${property}" without inject`)
      }
      return Reflect.get(target, property, receiver)
    },
  })

  return { ctx, registered, sections, channels, handlers, dynamicInjections, listeners }
}

/** A connection surface that records which channel was mounted, and its handler. */
function fakeConnection(channels: string[], handlers: unknown[] = []): unknown {
  return {
    rpc: {
      handle: (channel: string, handler: unknown) => {
        channels.push(channel)
        handlers.push(handler)
        return () => {}
      },
    },
    register: (_ctx: unknown, channel: string, handler: unknown) => {
      channels.push(channel)
      handlers.push(handler)
      return () => {}
    },
  }
}

describe('the fake context reproduces cordis\'s inject guard', () => {
  it('throws when an undeclared service is read as a property', () => {
    const { ctx } = fakeContext()
    // A name the plugin does NOT inject. It cannot be `connection` (declared for
    // the live channel) nor `tools`/`shell`/`shellEnv`: reading those as properties
    // is legal and the point of the suite. `sandboxPolicy` is read through the
    // TOLERANT `ctx.get`, so it stays undeclared and still proves the guard bites.
    expect(() => (ctx as { sandboxPolicy: unknown }).sandboxPolicy).toThrow(/without inject/)
  })

  it('allows reading a service the plugin declared', () => {
    const { ctx } = fakeContext()
    expect(() => (ctx as { shell: unknown }).shell).not.toThrow()
  })
})

describe('apply', () => {
  it('registers the tool when a connection service is present', () => {
    const channels: string[] = []
    const { ctx, registered } = fakeContext({ connection: fakeConnection(channels) })
    expect(() => { apply(ctx as never, {}) }).not.toThrow()
    expect(registered.map((definition) => definition.name)).toEqual([TOOL_NAME_PWSH])
    expect(channels).toEqual([PROGRESS_CHANNEL])
  })

  it('registers the tool when NO connection service is composed', () => {
    // The degradation path: no live position, but the tool and the card still work.
    const { ctx, registered } = fakeContext()
    expect(() => { apply(ctx as never, {}) }).not.toThrow()
    expect(registered.map((definition) => definition.name)).toEqual([TOOL_NAME_PWSH])
  })

  it('registers one tool per CONFIGURED dialect, and pwsh alone by default', () => {
    // The default matters: both tools ride the one `ctx.shell` seam, and that seam
    // cannot say which shell it is. A host running a PowerShell executor that also
    // offered a bash tool would send bash syntax INTO PowerShell, so the profile
    // opts in — `['pwsh']` out of the box.
    const defaults = fakeContext()
    apply(defaults.ctx as never, {})
    expect(defaults.registered.map((definition) => definition.name)).toEqual([TOOL_NAME_PWSH])

    const both = fakeContext()
    apply(both.ctx as never, { dialects: ['pwsh', 'bash'] })
    expect(both.registered.map((definition) => definition.name))
      .toEqual([TOOL_NAME_PWSH, TOOL_NAME_BASH])
  })

  it('declares every service it reads as a property', () => {
    // The rule this suite enforces, stated as data: a service the plugin touches
    // without injecting would have thrown above, but name it here so the
    // declaration stays visible next to the failure it prevents.
    // `connection` and `webServer` are both required: the live channel is mounted
    // through `register(ctx, ...)`, which resolves `webServer` off the OWNER
    // context, so declaring the connection without it makes registration throw.
    expect([...declaredInject].sort()).toEqual(['connection', 'shell', 'shellEnv', 'tools', 'webServer'])
  })

  it('adds the shell-tool guidance section, at the shell tool\'s own order', () => {
    const { ctx, sections, dynamicInjections } = fakeContext()
    apply(ctx as never, {})
    expect(dynamicInjections).toEqual([['systemPrompt']])
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe('tool:shell-progress')
    expect(sections[0]?.order).toBe(1010)
    expect(sections[0]?.text).toContain('shell_progress')
  })

  it('still registers the tool when the prompt service never arrives', () => {
    const { ctx, registered } = fakeContext()
    ;(ctx as { get: (name: string) => unknown }).get = () => undefined
    expect(() => { apply(ctx as never, {}) }).not.toThrow()
    expect(registered).toHaveLength(1)
  })

  it('publishes step progress through presentationMeta', () => {
    const { ctx, registered } = fakeContext()
    apply(ctx as never, {})
    const output = registered[0]?.output as { presentationMeta?: (args: unknown, value: unknown) => unknown }
    expect(typeof output.presentationMeta).toBe('function')
    const meta = { v: 1, instrumented: true, partial: false, preamble: '', steps: [] }
    expect(output.presentationMeta?.({}, { progress: meta })).toEqual(meta)
  })
})

/** A fake model that counts its requests and answers with one fixed text. */
function fakeLlm(answer: string): { readonly llm: unknown; readonly calls: () => number } {
  let calls = 0
  const llm = {
    stream: () => {
      calls += 1
      return (async function* generate() { yield { type: 'text', text: answer } })()
    },
  }
  return { llm, calls: () => calls }
}

type ChannelReply = { readonly ok: boolean; readonly value?: unknown }

/** One lazy notes request, as the card sends it. */
type NotesHandler = (endpoint: string, payload: unknown) => Promise<ChannelReply>

/** Mount the plugin over a fake connection and hand back the channel handler it registered. */
function mount(llm?: unknown): { readonly handler: NotesHandler; readonly channels: string[] } {
  const channels: string[] = []
  const handlers: unknown[] = []
  const { ctx } = fakeContext({ connection: fakeConnection(channels, handlers), ...llm === undefined ? {} : { llm } })
  apply(ctx as never, {})
  const handler = handlers[0] as NotesHandler | undefined
  if (handler === undefined) throw new Error('the plugin mounted no channel handler')
  return { handler, channels }
}

/**
 * A request for one card's notes.
 *
 * Each test uses DIFFERENT LINES: the cache is module-level and shared by this file, so a
 * repeated command would be answered from the previous test and the model-call counts below
 * would measure nothing.
 */
function notesRequest(lines: readonly string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { lines, locale: 'zh-CN', provider: 'deepseek', model: 'deepseek-chat', ...overrides }
}

describe('the notes endpoint', () => {
  it('writes one note per line, and answers the SAME command from cache', async () => {
    const { llm, calls } = fakeLlm('1: 安装依赖\n2: 构建产物')
    const { handler } = mount(llm)
    const request = notesRequest(['pnpm install', 'pnpm run build'])
    const first = await handler('notes', request)
    expect(first.ok).toBe(true)
    expect((first.value as { notes: unknown }).notes).toEqual(['安装依赖', '构建产物'])
    // THE SECOND ASK IS FREE: same lines, same language, same model. A reader runs the same
    // commands all day, and a card that missed its notes must not re-describe them.
    const second = await handler('notes', request)
    expect((second.value as { notes: unknown }).notes).toEqual(['安装依赖', '构建产物'])
    expect(calls()).toBe(1)
  })

  it('asks the model again for a different language', async () => {
    const { llm, calls } = fakeLlm('1: install\n2: build')
    const { handler } = mount(llm)
    const request = notesRequest(['pnpm install --frozen-lockfile', 'pnpm run build'])
    await handler('notes', request)
    await handler('notes', { ...request, locale: 'en' })
    // The cached sentence is in the wrong language, so a language switch must MISS.
    expect(calls()).toBe(2)
  })

  it('answers nothing for a malformed request, without asking the model', async () => {
    const { llm, calls } = fakeLlm('1: never')
    const { handler } = mount(llm)
    for (const payload of [{}, { lines: [] }, { lines: [1] }, { lines: ['x'] }, { ...notesRequest(['y']), provider: '' }]) {
      const answer = await handler('notes', payload)
      expect(answer.ok).toBe(true)
      expect((answer.value as { notes: unknown }).notes).toBeNull()
    }
    expect(calls()).toBe(0)
  })

  it('answers nothing when the host has no llm service', async () => {
    const { handler } = mount()
    const answer = await handler('notes', notesRequest(['git status']))
    expect((answer.value as { notes: unknown }).notes).toBeNull()
  })

  it('honours the reader\'s switch', async () => {
    const { llm, calls } = fakeLlm('1: 安装依赖')
    const { handler } = mount(llm)
    await handler('configure', { enabled: false, locale: 'zh-CN' })
    expect(((await handler('notes', notesRequest(['pnpm ci']))).value as { notes: unknown }).notes).toBeNull()
    expect(calls()).toBe(0)
    // The switch is module-level; leave it on for whatever runs after this file.
    await handler('configure', { enabled: true, locale: 'zh-CN' })
  })

  it('turns the wire\'s holes into null', async () => {
    // The model answered only the second line; JSON has no `undefined`, so the first is null.
    const { llm } = fakeLlm('2: 构建产物')
    const { handler } = mount(llm)
    const answer = await handler('notes', notesRequest(['pnpm install --offline', 'pnpm run build']))
    expect((answer.value as { notes: unknown }).notes).toEqual([null, '构建产物'])
  })
})

/**
 * A BACKGROUND call: the command goes to the host's job registry and the tool returns at
 * once with the job's id. The record written alongside it can only describe the command's
 * SHAPE, which is what the card draws (see `Row`'s background arm).
 */
describe('background jobs', () => {
  /** The registered tool's `execute`, which this suite is the only one to drive. */
  function executor(registered: readonly unknown[]): (args: Record<string, unknown>, exec: Record<string, unknown>) => Promise<unknown> {
    return (registered[0] as { execute: (args: Record<string, unknown>, exec: Record<string, unknown>) => Promise<unknown> }).execute
  }

  it('starts the command as a job and records that it did', async () => {
    const started: unknown[] = []
    const { ctx, registered } = fakeContext({
      jobs: { start: (job: unknown) => { started.push(job); return 'job-42' } },
    })
    apply(ctx as never, {})
    // Catch the request the job's executor is handed: it is the ONE thing that decides what
    // the command's output looks like, and the model reads that output.
    const resolved: unknown[] = []
    ;(ctx as unknown as { shell: { resolve: (request: unknown) => unknown } }).shell.resolve = (request: unknown) => {
      resolved.push(request)
      return {}
    }
    const value = await executor(registered)({
      // ONE statement, so the split needs no parser probe: this suite must not depend on a
      // shell being installed.
      command: 'Write-Output 1',
      description: 'one statement',
      run_in_background: true,
    }, { callId: 'call-bg', signal: new AbortController().signal }) as {
      readonly kind: string
      readonly jobId: string
      readonly progress: {
        readonly background?: boolean
        readonly jobId?: string
        readonly instrumented: boolean
        readonly partial: boolean
        readonly steps: readonly { readonly text: string }[]
      }
    }
    expect(value.kind).toBe('background')
    expect(value.jobId).toBe('job-42')
    // The card's whole fact: this was a job, and which one.
    expect(value.progress.background).toBe(true)
    expect(value.progress.jobId).toBe('job-42')
    // NOT instrumented on purpose — the job's output is what the model reads, and a marker
    // line in it would be output the model actually sees.
    expect(value.progress.instrumented).toBe(false)
    expect(value.progress.steps.map((step) => step.text)).toEqual(['Write-Output 1'])

    // THE COMMAND ITSELF: the plain text, never the marked text the foreground path builds.
    // Measured live before this was pinned: `job_output` on a real background call returned
    // `__DSH_STEP_<nonce>_1__` lines above the command's own output, because the spec still
    // carried `request.command`.
    const spec = resolved[0] as { readonly command: string; readonly onExpiry?: string }
    expect(spec.command, 'the background command was instrumented').toBe('Write-Output 1')
    expect(spec.command, 'the background command carries a step marker').not.toContain('__DSH_STEP_')
    // No deadline of its own: `job_kill` is a job's stop.
    expect(spec.onExpiry).toBe('none')

    // The spec the registry was handed: the command as its label, both captured streams as
    // PULL sources (so `job_output` reads them), and hooks that spawn nothing until run.
    const job = started[0] as {
      readonly kind: string
      readonly label: string
      readonly output: readonly { readonly channel: string }[]
      run(): { readonly done: Promise<unknown>; readonly cancel: (reason: string) => void }
    }
    expect(job.kind).toBe(TOOL_NAME_PWSH)
    expect(job.label).toBe('Write-Output 1')
    expect(job.output.map((source) => source.channel)).toEqual(['stdout', 'stderr'])
    // A spawn that throws is an OUTCOME, never a rejection — this suite's fake executor
    // throws, which is exactly the infrastructure-failure path.
    const outcome = await job.run().done as { readonly status: string; readonly detail: string }
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('execute is not exercised')
  })

  it('refuses run_in_background on a host with no job registry', async () => {
    const { ctx, registered } = fakeContext()
    apply(ctx as never, {})
    await expect(executor(registered)({
      command: 'Write-Output 1',
      description: 'one statement',
      run_in_background: true,
    }, { callId: 'call-bg-2', signal: new AbortController().signal })).rejects.toThrow(/job registry/)
  })
})

describe('advisory notice', () => {
  /** The notice messages a decision carries, if any. */
  type Notices = readonly {
    readonly content: readonly { readonly text?: string }[]
    readonly source: { readonly kind: string; readonly form?: string }
  }[]

  /** Run the plugin's post-execute listener for one call, as the registry would. */
  async function dispatch(
    listeners: { readonly event: string; readonly handler: Listener }[],
    name: string,
    options: { readonly parent?: object; readonly agent?: object } = {},
  ): Promise<Record<string, unknown>> {
    const listener = listeners.find((entry) => entry.event === 'tools/post-execute')
    if (listener === undefined) throw new Error('the plugin registered no tools/post-execute listener')
    return await listener.handler({ name, ...options }, undefined, async () => ({
      kind: 'accept',
      content: [{ type: 'text', text: 'ok' }],
    })) as Record<string, unknown>
  }

  /** The notice's own text, from the decision it was attached to. */
  function noticeText(decision: Record<string, unknown>): string {
    const contexts = decision.additionalContexts as Notices | undefined
    return contexts?.[0]?.content.map((part) => part.text ?? '').join('') ?? ''
  }

  it('adds one notice after the first native call, and one only', async () => {
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, {})

    const first = await dispatch(listeners, 'pwsh')
    const notices = first.additionalContexts as Notices | undefined
    expect(notices).toHaveLength(1)
    expect(notices?.[0]?.source.kind).toBe('shell-progress-suggestion')
    expect(notices?.[0]?.source.form).toBe('notice')
    // The text names the tools and the promise, not a parameter: the notice must not need
    // editing when a tool gains one.
    expect(noticeText(first)).toContain('shell_progress_pwsh')
    expect(noticeText(first)).toContain('`pwsh`')
    expect(noticeText(first)).toContain('same executor')
    expect(noticeText(first), 'the notice names an internal parameter').not.toContain('run_in_background')

    // The second call of the same session gets nothing: one anchoring reminder, then the
    // cooldown — there is no count cap and no tenth-call rule any more.
    expect((await dispatch(listeners, 'pwsh')).additionalContexts).toBeUndefined()
  })

  it('reports a relapse: a native call after the progress tool was used', async () => {
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, {})
    // The agent tried the progress tool first, so its first native call is a relapse, not an
    // anchor: it is the switch BACK that is worth a word.
    expect((await dispatch(listeners, 'shell_progress_pwsh')).additionalContexts).toBeUndefined()
    const relapse = await dispatch(listeners, 'pwsh')
    expect(relapse.additionalContexts as Notices | undefined).toHaveLength(1)
    expect(noticeText(relapse)).toContain('shell_progress_pwsh')
  })

  it('holds the cooldown: one notice an hour per agent', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-23T10:00:00Z'))
      const { ctx, listeners } = fakeContext()
      apply(ctx as never, {})
      expect((await dispatch(listeners, 'pwsh')).additionalContexts, 'the anchor notice').toHaveLength(1)

      // Four minutes later the agent relapses — inside the hour, so the notice is held.
      await dispatch(listeners, 'shell_progress_pwsh')
      vi.setSystemTime(new Date('2026-10-23T10:04:00Z'))
      expect((await dispatch(listeners, 'pwsh')).additionalContexts, 'a notice inside the cooldown').toBeUndefined()

      // Past the hour, the next relapse is worth the word.
      await dispatch(listeners, 'shell_progress_pwsh')
      vi.setSystemTime(new Date('2026-10-23T11:05:00Z'))
      expect((await dispatch(listeners, 'pwsh')).additionalContexts, 'the cooldown outlasted an hour').toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a blocked decision blocked, with the notice attached', async () => {
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, {})
    const listener = listeners.find((entry) => entry.event === 'tools/post-execute')
    if (listener === undefined) throw new Error('the plugin registered no tools/post-execute listener')
    const feedback = [{ type: 'text', text: 'denied downstream' }]
    const decision = await listener.handler({ name: 'pwsh' }, undefined, async () => ({ kind: 'block', feedback })) as Record<string, unknown>
    expect(decision.kind).toBe('block')
    expect(decision.feedback).toEqual(feedback)
    expect(decision.additionalContexts as Notices | undefined).toHaveLength(1)
  })

  it('says nothing about a nested dispatch, where a program chose the tool', async () => {
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, {})
    expect((await dispatch(listeners, 'pwsh', { parent: {} })).additionalContexts).toBeUndefined()
  })

  it('says nothing about non-shell tools, nor about the progress tool itself', async () => {
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, {})
    expect((await dispatch(listeners, 'read')).additionalContexts).toBeUndefined()
    expect((await dispatch(listeners, 'shell_progress_pwsh')).additionalContexts).toBeUndefined()
  })

  it('names the bash pair when bash is the configured dialect', async () => {
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, { dialects: ['bash'] })
    const decision = await dispatch(listeners, 'bash')
    expect(noticeText(decision)).toContain('shell_progress_bash')
    expect(noticeText(decision)).toContain('`bash`')
  })

  it('can be turned off, leaving no listener behind', () => {
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, { advisory: false })
    expect(listeners).toHaveLength(0)
  })
})

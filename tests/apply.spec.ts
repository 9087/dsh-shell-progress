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

import { describe, expect, it } from 'vitest'
import { apply, inject as declaredInject } from '../src/index.ts'
import { PROGRESS_CHANNEL, TOOL_NAME_BASH, TOOL_NAME_PWSH } from '../src/types.ts'

/** Service names the fake context hosts; an undeclared read of any of them throws. */
const KNOWN_SERVICES = ['tools', 'shell', 'shellEnv', 'connection', 'systemPrompt', 'sandboxPolicy']

interface Section {
  readonly name: string
  readonly order: number
  readonly text: string
}

/** A context good enough for `apply`, with cordis's inject guard reproduced. */
function fakeContext(options: { readonly connection?: unknown } = {}): {
  readonly ctx: unknown
  readonly registered: { readonly name: string; readonly output: unknown }[]
  readonly sections: Section[]
  readonly channels: string[]
  readonly dynamicInjections: string[][]
} {
  const registered: { name: string; output: unknown }[] = []
  const sections: Section[] = []
  const channels: string[] = []
  const dynamicInjections: string[][] = []
  const declared = new Set<string>(declaredInject)

  const base: Record<string, unknown> = {
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

  return { ctx, registered, sections, channels, dynamicInjections }
}

/** A connection surface that records which channel was mounted. */
function fakeConnection(channels: string[]): unknown {
  return {
    rpc: {
      handle: (channel: string) => {
        channels.push(channel)
        return () => {}
      },
    },
    register: (_ctx: unknown, channel: string) => {
      channels.push(channel)
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

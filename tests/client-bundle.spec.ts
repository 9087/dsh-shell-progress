/**
 * The CLIENT bundle, loaded and rendered without a browser.
 *
 * The host half's load failure was invisible to every pure-function suite and
 * cost a restart cycle to find. The client half is harder to observe (it only
 * runs in a page) and fails just as quietly: an unloadable bundle, or a
 * registration that quietly throws, leaves the card as the generic tool row.
 *
 * So this suite takes the BUILT artifact — `lib/client.js`, the exact bytes the
 * shell serves — executes its `__ModuleLoader__` handoff, applies the plugin to
 * a stub context, and renders the registered component. It is the last link in
 * the chain that cannot be covered by unit tests of the source alone.
 *
 * It exercises the artifact, so it needs a build: `pnpm run build && pnpm test`.
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// Under vitest `import.meta.url` is an http URL, so paths come from the test
// runner's root instead.
const PROJECT_ROOT = process.cwd()
const nodeRequire = createRequire(join(PROJECT_ROOT, 'package.json'))
const CLIENT_BUNDLE = join(PROJECT_ROOT, 'lib', 'client.js')

/** One `__ModuleLoader__.load` handoff. */
interface Loaded {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => Record<string, unknown>
}

/** A stub standing in for a platform module, tolerant of any named import. */
function stubModule(extra: Record<string, unknown> = {}): unknown {
  return new Proxy({ __esModule: true, ...extra }, {
    get(target, property, receiver) {
      if (property === '__esModule') return true
      if (property === 'default') return receiver
      if (property === 'then') return undefined // not a thenable, whatever the bundler asks
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
      // Any other named import is a component, and it PASSES ITS CHILDREN
      // THROUGH rather than rendering nothing. A `() => null` stand-in is what
      // once let a real layout bug ship: the bar was collapsing inside a wrapper
      // the stub had dropped, so every assertion passed and the screen showed an
      // empty card. The published primitives cannot simply be imported here —
      // they pull in their own CSS and a transitive surface
      // (`@shikijs/langs/...`) that only the shell's frozen module table
      // answers, which is a property of this test host, not of the plugin.
      return (props: Record<string, unknown> = {}) => createElement(
        'div',
        null,
        props.icon as never,
        props.title === undefined ? null : String(props.title),
        props.collapsedContent as never,
        // `children` are the EXPANDED body: the real disclosure renders them
        // only while open, and a stand-in that rendered both at once would
        // double every per-step attribute the assertions count.
        props.open === true ? (props.children as never) : null,
      )
    },
  })
}

/** The loader table the shell injects, answered with stubs (plus real React). */
function loaderRequire(id: string): unknown {
  if (id === 'react' || id === 'react/jsx-runtime' || id === 'react-dom' || id === 'react-dom/client') {
    return nodeRequire(id)
  }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return stubModule({
      // The primitives this card really uses, with just enough behaviour.
      StateDot: () => null,
      // The card's ANCHOR, and only the anchor: the card itself is portaled and opens on
      // hover, which no width measurement in this file reaches. A stand-in that WRAPPED
      // the anchor would change the bar's measured widths — which is exactly why the
      // wrapper the real `HoverCard` inserts is taken out of layout in the stylesheet.
      HoverCard: ({ anchor }: { anchor: unknown }) => anchor,
    })
  }
  return stubModule()
}

/** Execute the built bundle and capture its module-loader handoff. */
async function loadClientBundle(): Promise<Loaded> {
  const code = await readFile(CLIENT_BUNDLE, 'utf8')
  const loaded: Loaded[] = []
  const moduleShim = { exports: {} as Record<string, unknown> }
  const windowShim = { __ModuleLoader__: { load: (entry: Loaded) => { loaded.push(entry) } } }
  // The bundle is browser CJS: a closure factory handed to the loader. Running
  // it here with a `window` and a `require` is exactly what the shell does.
  const run = new Function('window', 'module', 'exports', 'require', code)
  run(windowShim, moduleShim, moduleShim.exports, loaderRequire)
  expect(loaded).toHaveLength(1)
  return loaded[0] as Loaded
}

/** A client context that records what the plugin registers. */
function fakeClientContext(): {
  readonly ctx: unknown
  readonly registrations: { options: Record<string, unknown>; component: unknown }[]
  readonly injectedSlots: string[]
  readonly dictionaries: string[]
} {
  const registrations: { options: Record<string, unknown>; component: unknown }[] = []
  const injectedSlots: string[] = []
  const dictionaries: string[] = []
  const ctx = {
    slots: {
      inject: (name: string, callback: () => unknown) => {
        injectedSlots.push(name)
        return callback()
      },
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    locale: {
      register: (namespace: string) => {
        dictionaries.push(namespace)
        return () => {}
      },
      bind: () => (key: string) => key,
    },
    connection: { rpc: { call: async () => ({ ok: false, error: { code: 'internal', message: 'stub' } }) } },
    effect: (fn: () => unknown) => fn(),
    on: () => () => {},
  }
  return { ctx, registrations, injectedSlots, dictionaries }
}

const COMMAND = [
  'Write-Output "[1/4] fetch"',
  'Write-Output "[2/4] build"',
  'Write-Output "[3/4] test"',
  'Write-Output "[4/4] pack"',
].join('\n')

describe('the built client bundle', () => {
  it('loads through the module loader and exports the plugin contract', async () => {
    const entry = await loadClientBundle()
    expect(entry.id).toBe('dsh-shell-progress')
    const module = entry.factory(loaderRequire)
    expect(module.name).toBe('ui-shell-progress')
    expect(module.inject).toEqual(['slots', 'locale', 'connection'])
    expect(typeof module.apply).toBe('function')
  })

  it('registers its own toolview key and its dictionaries', async () => {
    const entry = await loadClientBundle()
    const module = entry.factory(loaderRequire) as { apply: (ctx: unknown) => void }
    const { ctx, registrations, injectedSlots, dictionaries } = fakeClientContext()
    expect(() => { module.apply(ctx) }).not.toThrow()

    // `slots.inject` is what makes the contribution wait for the slot's
    // declaration and leave with this plugin's fiber. It runs ONCE PER WIRE NAME:
    // a name the client registers no view for falls back to the generic tool row,
    // so a missing view is a progress bar that silently never appears.
    // THREE seats: the two toolview keys (one per dialect) and this plugin's DSH Settings
    // section. The section goes through the same `slots.inject` path on purpose — a slot
    // owned by another package has to be WAITED for, never assumed to exist yet.
    expect(injectedSlots).toEqual(['tool.call.toolview', 'tool.call.toolview', 'settings.section'])
    // Two tool CALL views and one settings section, in apply order.
    expect(registrations).toHaveLength(3)
    const views = registrations.filter((entry) => entry.options.name === 'tool.call.toolview')
    const sections = registrations.filter((entry) => entry.options.name === 'settings.section')
    expect(views, 'the two dialect views are not both registered').toHaveLength(2)
    expect(sections, 'this plugin has no DSH Settings section').toHaveLength(1)
    // The wire tool names — and never `pwsh`.
    expect(views.map((entry) => entry.options.key))
      .toEqual(['shell_progress_pwsh', 'shell_progress_bash'])
    for (const entry of views) {
      expect(entry.options.name).toBe('tool.call.toolview')
      expect(entry.options.locale).toBe('shell-progress')
    }
    expect(dictionaries).toEqual(['shell-progress'])
  })

  it('hands the component an observable, not a subscription of its own', async () => {
    const entry = await loadClientBundle()
    const module = entry.factory(loaderRequire) as { apply: (ctx: unknown) => void }
    const { ctx, registrations } = fakeClientContext()
    module.apply(ctx)
    const inject = registrations[0]?.options.inject as () => Record<string, unknown>
    const face = inject()
    // The observable lives INSIDE the reserved `hooks` compartment — folding a
    // plain function in there would stop the whole compartment from matching.
    const hooks = face.hooks as { progress?: { getSnapshot?: unknown; subscribe?: unknown } }
    const progress = hooks.progress
    expect(typeof progress?.getSnapshot).toBe('function')
    expect(typeof progress?.subscribe).toBe('function')
    expect(typeof face.watchCall).toBe('function')
  })

  it('renders one progress segment per top-level step, from the host\'s metadata', async () => {
    const entry = await loadClientBundle()
    const module = entry.factory(loaderRequire) as { apply: (ctx: unknown) => void }
    const { ctx, registrations } = fakeClientContext()
    module.apply(ctx)
    const Component = registrations[0]?.component as (props: unknown) => unknown

    // A SETTLED block carrying the host's OWN step metadata: this is the only
    // source the card may draw segments from (see `./model`'s header — the
    // client cannot run a parser, and it no longer guesses).
    const html = renderCall(Component, {
      kind: 'tool-result',
      callId: 'call-1',
      call: { name: 'shell_progress', argsRaw: JSON.stringify({ command: COMMAND, description: 'demo' }) },
      content: [],
      isError: false,
      meta: {
        v: 1,
        instrumented: true,
        refused: false,
        partial: false,
        preamble: '',
        steps: COMMAND.split('\n').map((text, index) => ({
          line: index + 1,
          text,
          output: '',
          startedAt: index * 10,
          endedAt: index * 10 + 5,
        })),
      },
    })
    // Four segments, each carrying its phase; plus a header and the counter.
    expect((html.match(/data-phase=/g) ?? [])).toHaveLength(4)
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('row.title')
    expect(html).toContain('row.counter')
  })

  it('draws NO bar and NO rows for a settled block with no metadata', async () => {
    const entry = await loadClientBundle()
    const module = entry.factory(loaderRequire) as { apply: (ctx: unknown) => void }
    const { ctx, registrations } = fakeClientContext()
    module.apply(ctx)
    const Component = registrations[0]?.component as (props: unknown) => unknown

    // The same four-line command, still settled, but the host persisted no steps.
    // Old behaviour drew four GUESSED segments here; the guess is gone.
    const html = renderCall(Component, {
      kind: 'tool-result',
      callId: 'call-1',
      call: { name: 'shell_progress', argsRaw: JSON.stringify({ command: COMMAND, description: 'demo' }) },
      content: [],
      isError: false,
    })
    expect((html.match(/data-phase=/g) ?? [])).toHaveLength(0)
    expect(html).not.toContain('role="progressbar"')
    // The card is still the call's own row; it simply has nothing to measure yet.
    expect(html).toContain('row.title')
  })
})

/** Render the first registered view for one call block. */
function renderCall(Component: (props: unknown) => unknown, block: Record<string, unknown>): string {
  const props = {
    callId: 'call-1',
    toolName: 'shell_progress',
    block,
    t: (key: string, params?: Record<string, unknown>) => {
      let out = key
      for (const [name, value] of Object.entries(params ?? {})) out += ` ${name}=${String(value)}`
      return out
    },
    useProgress: (select: (snapshot: { calls: Record<string, never> }) => unknown) => select({ calls: {} }),
    watchCall: () => () => {},
  }
  return renderToStaticMarkup(createElement(Component as never, props as never))
}

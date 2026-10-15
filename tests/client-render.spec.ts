/**
 * The BUILT client bundle, rendered and measured without a browser.
 *
 * This is the suite that answers "does the card actually draw?", which the
 * stubbed registration suite next door cannot: the live host rendered the
 * header, the description and `4/4 步`, yet the bar itself was invisible. The
 * cause was layout — a `flex-basis: 0` track nested in a shrink-to-fit wrapper,
 * which resolves to zero width — so these assertions pin the two things that
 * keep it from coming back: the segments are in the markup, and the stylesheet
 * the bundle injects still carries the explicit sizes.
 *
 * Exercises the artifact: `pnpm run build && pnpm test`.
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = process.cwd()
const nodeRequire = createRequire(join(PROJECT_ROOT, 'package.json'))
const CLIENT_BUNDLE = join(PROJECT_ROOT, 'lib', 'client.js')

interface Loaded {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => Record<string, unknown>
}

/**
 * Stand-ins for the platform modules, plus the real React.
 *
 * The primitives are stubbed rather than loaded for real: the published package
 * imports `clsx`, which pnpm's isolated layout does not make resolvable from
 * this repo, and in the browser the shell's frozen module table answers for it
 * anyway. The bar these tests measure no longer depends on any primitive.
 */
function stub(extra: Record<string, unknown> = {}): unknown {
  return new Proxy({ __esModule: true, ...extra }, {
    get(target, property, receiver) {
      if (property === '__esModule') return true
      if (property === 'default') return receiver
      if (property === 'then') return undefined
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
      // A component stand-in that PASSES ITS CHILDREN THROUGH — see the note on
      // `loaderRequire` for why rendering nothing is the one thing it must not
      // do.
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

/**
 * Answer with the REAL modules where they load under Node, and an honest
 * pass-through stand-in for the platform UI package.
 *
 * The published primitives cannot be imported in this host at all: they pull in
 * their own `.module.css` (which Node's loader refuses) and a transitive surface
 * only the shell's frozen module table answers. So their components are stubbed
 * — but the stub PASSES CHILDREN THROUGH. The earlier `() => null` version is
 * exactly what hid the first real bug, because the wrapper it removed was the
 * one collapsing the bar to zero width.
 */
function loaderRequire(id: string): unknown {
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return stub({
      // A tooltip's anchor is ALWAYS visible, and the generic stand-in above
      // renders `children` only for an OPEN disclosure — so without this entry
      // every segment the bar draws disappeared from the tree. The label is
      // rendered as a `title`, which is what the real bubble shows on hover and
      // what the assertions below read back.
      Tooltip: (props: Record<string, unknown>) => createElement(
        'div',
        {
          // The real bubble builds its text when it becomes visible, and `label`
          // accepts a RESOLVER for exactly that reason — so the stand-in calls it
          // rather than stringifying a function.
          title: typeof props.label === 'function'
            ? String((props.label as () => string)())
            : String(props.label),
        },
        props.children as never,
      ),
    })
  }
  if (id === 'react' || id === 'react/jsx-runtime' || id === 'react-dom' || id === 'react-dom/server') {
    return nodeRequire(id)
  }
  return stub()
}

async function loadBundle(): Promise<Loaded> {
  const code = await readFile(CLIENT_BUNDLE, 'utf8')
  const loaded: Loaded[] = []
  const moduleShim = { exports: {} as Record<string, unknown> }
  const windowShim = { __ModuleLoader__: { load: (entry: Loaded) => { loaded.push(entry) } } }
  const run = new Function('window', 'module', 'exports', 'require', code)
  run(windowShim, moduleShim, moduleShim.exports, loaderRequire)
  expect(loaded).toHaveLength(1)
  return loaded[0] as Loaded
}

const COMMAND = [
  'Write-Output "[1/4] fetch"',
  'Write-Output "[2/4] build"',
  'Write-Output "[3/4] test"',
  'Write-Output "[4/4] pack"',
].join('\n')

/** A settled call whose persisted metadata says every step finished. */
function settledBlock(): Record<string, unknown> {
  return {
    kind: 'tool-result',
    callId: 'call-1',
    call: { name: 'shell_progress', argsRaw: JSON.stringify({ command: COMMAND, description: 'demo' }) },
    content: [],
    isError: false,
    meta: {
      v: 1,
      instrumented: true,
      partial: false,
      preamble: '',
      steps: [
        { line: 1, text: 'Write-Output "[1/4] fetch"', output: '[1/4] fetch', startedAt: 0, endedAt: 120 },
        { line: 2, text: 'Write-Output "[2/4] build"', output: '[2/4] build', startedAt: 120, endedAt: 240 },
        { line: 3, text: 'Write-Output "[3/4] test"', output: '[3/4] test', startedAt: 240, endedAt: 360 },
        { line: 4, text: 'Write-Output "[4/4] pack"', output: '[4/4] pack', startedAt: 360, endedAt: 480 },
      ],
    },
  }
}

/**
 * A settled call the host REFUSED to instrument: the metadata says so explicitly,
 * and its step list is EMPTY — a refusal is not a guess, so nothing is planned.
 *
 * This is the record that would lose its notice if the card read a step count:
 * `total` is 0, so `total > 1` is false and the notice would vanish silently.
 */
function refusedBlock(): Record<string, unknown> {
  return {
    ...settledBlock(),
    meta: { v: 1, instrumented: false, refused: true, partial: false, preamble: '', steps: [] },
  }
}

/** A settled call that simply had ONE step: uninstrumented, and not refused. */
function singleStepBlock(): Record<string, unknown> {
  const command = 'Write-Output "[1/1] only"'
  return {
    ...settledBlock(),
    call: { name: 'shell_progress', argsRaw: JSON.stringify({ command, description: 'one step' }) },
    meta: {
      v: 1,
      instrumented: false,
      refused: false,
      partial: false,
      preamble: '',
      steps: [{ line: 1, text: command, output: '', startedAt: null, endedAt: null }],
    },
  }
}

/** Register the card out of the bundle and render it for one settled call. */
async function renderCard(
  block: Record<string, unknown> = settledBlock(),
  live?: Record<string, unknown>,
): Promise<string> {
  const entry = await loadBundle()
  const module = entry.factory(loaderRequire) as { apply: (ctx: unknown) => void }
  const registrations: { component: unknown }[] = []
  module.apply({
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (_options: Record<string, unknown>, component: unknown) => {
        registrations.push({ component })
        return () => {}
      },
    },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    connection: { rpc: { call: async () => ({ ok: false, error: { code: 'internal', message: 'stub' } }) } },
    effect: (fn: () => unknown) => fn(),
    on: () => () => {},
  })
  const Component = registrations[0]?.component as (props: unknown) => unknown
  const props = {
    callId: 'call-1',
    toolName: 'shell_progress',
    phase: 'result',
    block,
    t: (key: string, params?: Record<string, unknown>) => {
      let out = key
      for (const [name, value] of Object.entries(params ?? {})) out += ` ${name}=${String(value)}`
      return out
    },
    useProgress: (select: (snapshot: { calls: Record<string, never> }) => unknown) =>
      select({ calls: live === undefined ? {} : { 'call-1': live } as never }),
    watchCall: () => () => {},
  }
  return renderToStaticMarkup(createElement(Component as never, props as never))
}

describe('the built client bundle, rendered', () => {
  it('injects one stylesheet per CSS module when the factory runs', async () => {
    const entry = await loadBundle()
    // The factory is what evaluates the modules, and the style tags are
    // injected as a module side effect — so this call is the subject.
    entry.factory(loaderRequire)
    const styles = Array.from(document.querySelectorAll('style[data-plugin="dsh-shell-progress"]'))
    expect(styles).toHaveLength(3)
    const css = styles.map((node) => node.textContent ?? '').join('\n')
    // The two declarations that make the bar visible. Their absence is the exact
    // regression this suite exists for.
    expect(css).toContain('height:6px')
    expect(css).toContain('min-width:48px')
    // A loaded token, so the segments are not merely transparent.
    expect(css).toContain('--dsw-alias-state-success-primary')
  })

  it('draws one segment per step, each with an accessible name and its command', async () => {
    const html = await renderCard()
    expect((html.match(/data-phase="done"/g) ?? [])).toHaveLength(4)
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuemax="4"')
    expect(html).toContain('aria-valuenow="4"')
    // Hovering a segment shows the STEP'S OWN COMMAND AND ITS TIME — the same two
    // things the expanded row shows. Its source line number is deliberately NOT in
    // the bubble: the card points at the matching row instead.
    expect(html).toContain('title=')
    expect(html).toContain('[1/4] fetch')
    expect(html).toContain('[0s]')
  })

  it('puts a real hashed class on the track, so the layout is not unstyled', async () => {
    const html = await renderCard()
    const track = /class="([^"]*)"[^>]*role="progressbar"/.exec(html)
    expect(track).not.toBeNull()
    const classes = track?.[1] ?? ''
    expect(classes.length).toBeGreaterThan(4)
    expect(classes).not.toBe('undefined')
  })

  // The rendered proof for the refusal signal. The notice has to hang on the flag,
  // because a REFUSED card has zero steps — `total > 1` is false for it — and it
  // must still be invisible for a command that merely had one step.

  it('shows the "ran unmodified" notice for a REFUSED call with no steps at all', async () => {
    const html = await renderCard(refusedBlock())
    // Not one segment and not one step row: the refusal planned none. The notice is
    // still there, because the card draws it at its OWN level — below the progress
    // line — rather than inside a per-step row that an empty list never renders.
    expect((html.match(/data-phase=/g) ?? [])).toHaveLength(0)
    expect(html).toContain('row.notInstrumented')
    // Where it draws matters: the notice is the CARD's own paragraph, a sibling of
    // the header and the progress line — not a piece of a per-step row, which a
    // zero-step list never renders.
    expect(/<p class="[^"]+">row\.notInstrumented<\/p>/.test(html)).toBe(true)
  })

  it('keeps that notice off a single-step command that was merely uninstrumented', async () => {
    const html = await renderCard(singleStepBlock())
    expect(html).not.toContain('row.notInstrumented')
    // It is still a card with its own counter; it just has nothing to warn about.
    expect(html).toContain('row.counter')
  })

  // The pin for C-6. The browser cannot run a parser, so a bar drawn before the
  // host answers could only be a guess at the step boundaries. It is gone: the
  // card draws nothing until the host's own data arrives.

  /** A RUNNING call: the block is not settled, so the view comes from the LIVE source. */
  function runningBlock(): Record<string, unknown> {
    return {
      kind: 'tool-call',
      callId: 'call-1',
      name: 'shell_progress',
      argsRaw: JSON.stringify({ command: COMMAND, description: 'demo' }),
    }
  }

  /** The host's answer for that call: the four steps are ITS statement list. */
  function liveSnapshot(): Record<string, unknown> {
    return {
      found: true,
      running: true,
      instrumented: true,
      refused: false,
      partial: false,
      current: 1,
      total: 4,
      elapsedMs: 1_000,
      preamble: '',
      steps: COMMAND.split('\n').map((text, index) => ({
        line: index + 1,
        text,
        output: '',
        startedAt: index === 0 ? 0 : null,
        endedAt: index === 0 ? 100 : null,
      })),
    }
  }

  it('draws no bar and no rows before the host answers, then draws both', async () => {
    // What the host says when it has no record yet. `found: false` is a real
    // answer — "I have not registered this call" — not a transport failure.
    const before = await renderCard(runningBlock(), {
      found: false,
      running: false,
      instrumented: false,
      refused: false,
      partial: false,
      current: null,
      total: 0,
      elapsedMs: 0,
      preamble: '',
      steps: [],
    })
    // NO bar (so no segments) and no counter. The step ROWS are not in this
    // markup either, for a second reason: the tree is collapsed by default, and
    // a static render never opens it — which is why the row-level pin lives in
    // `./model.spec.ts`, where `view.steps` is read directly.
    expect(before).not.toContain('role="progressbar"')
    expect((before.match(/data-phase=/g) ?? [])).toHaveLength(0)
    expect(before).not.toContain('row.counter')
    expect(before).not.toContain('data-step')
    // The card is still the call's own row: it has simply nothing to measure.
    expect(before).toContain('row.title')

    // ...and with the host's data, the bar and its one segment per step appear.
    const after = await renderCard(runningBlock(), liveSnapshot())
    expect(after).toContain('role="progressbar"')
    expect((after.match(/data-phase=/g) ?? [])).toHaveLength(4)
    expect(after).toContain('aria-valuemax="4"')
    expect(after).toContain('row.counter done=1 total=4')
  })
})

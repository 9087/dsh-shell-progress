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
      // A hover card's anchor is ALWAYS visible, and the generic stand-in above
      // differs from the Tooltip stand-in this replaces: a card's content is rendered
      // only while the card is OPEN, and opening is a hover, which a static render
      // never reaches. So the stand-in renders BOTH halves unconditionally — the
      // anchor in place, the content inside a wrapper marked `data-card-host`, which
      // is the seam the helpers below read one segment's card out of. Without this
      // entry the generic stand-in above applies, and that one renders `children` only
      // for an open disclosure, so every segment the bar draws would vanish.
      HoverCard: (props: Record<string, unknown>) => createElement(
        'div',
        null,
        props.anchor as never,
        createElement('div', { 'data-card-host': 'true' }, props.content as never),
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
 * A settled call the host REFUSED to instrument, in the CURRENT record shape: the flag, and
 * ONE step whose text is the WHOLE command — the command is real, only its division is
 * missing. Its output rides that one step, because the tracker was given that one step to
 * attribute to.
 *
 * The card must draw the same single segment a one-line command draws, plus a `!` in the
 * header saying the command was not split — see the refusal tests below.
 */
function refusedBlock(): Record<string, unknown> {
  const command = 'Write-Output "a: b"\n"$v: c"'
  return {
    ...settledBlock(),
    call: {
      name: 'shell_progress',
      argsRaw: JSON.stringify({ command, description: 'refused demo' }),
    },
    meta: {
      v: 1,
      instrumented: false,
      refused: true,
      partial: false,
      preamble: '',
      steps: [{ line: 1, text: command, output: 'the whole output\nstill the whole output', startedAt: 0, endedAt: 5 }],
    },
  }
}

/**
 * A refused record in the PREVIOUS shape: NO steps, the output in the preamble. No current
 * host writes this — it is what an older session log replays — and the card keeps the plain
 * body for it, because with no step there is nothing to draw a bar from.
 */
function legacyRefusedBlock(): Record<string, unknown> {
  return {
    ...settledBlock(),
    call: {
      name: 'shell_progress',
      argsRaw: JSON.stringify({ command: 'Write-Output "a: b"', description: 'refused demo' }),
    },
    meta: {
      v: 1,
      instrumented: false,
      refused: true,
      partial: false,
      preamble: 'the whole output\nstill the whole output',
      steps: [],
    },
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

/** A settled call whose ONE step had its output truncated by the per-step budget. */
function truncatedBlock(): Record<string, unknown> {
  const command = 'Get-Content huge.log'
  return {
    ...settledBlock(),
    call: { name: 'shell_progress', argsRaw: JSON.stringify({ command, description: 'chatty step' }) },
    meta: {
      v: 1,
      instrumented: true,
      refused: false,
      partial: true,
      preamble: '',
      steps: [{ line: 1, text: command, output: 'first line', droppedChars: 1234, startedAt: 0, endedAt: 5 }],
    },
  }
}

/**
 * The four-step settled call with each step's output REPLACED.
 *
 * The card has three edges the four uniform fixture outputs never reach: output
 * that is empty, output that is far too long, and output whose characters happen to
 * look like markup.
 * @param outputs - one output per step, in order.
 * @returns the call block.
 */
function withOutputs(outputs: readonly string[]): Record<string, unknown> {
  const block = settledBlock()
  const meta = block.meta as { steps: { output: string }[] }
  meta.steps.forEach((step, index) => { step.output = outputs[index] ?? '' })
  return block
}

/** The characters React escapes in a text child, back to the characters themselves. */
function unescape(html: string): string {
  return html
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'")
    .replace(/&amp;/gu, '&')
}

/** One segment's hover card, as the shipped bundle renders it. */
interface Card {
  /** The command line's own text, with the clock taken off it. */
  readonly command: string
  /** The clock that line carries, or null when the step is still pending. */
  readonly clock: string | null
  /** The output block's RAW markup, so an escaping assertion can still see it. */
  readonly output: string | null
  /** True when the card drew a divider between the command and the output. */
  readonly divider: boolean
  /** How many highlighted runs the command line carries. */
  readonly tokenSpans: number
}

/**
 * The hover cards in a rendered card, one per segment, in bar order.
 *
 * The `HoverCard` stand-in marks where each card's content begins
 * (`data-card-host`), and the bar is the only thing this fixture renders, so the chunk
 * after each marker is exactly one segment's card.
 * @param html - the rendered card.
 * @returns one entry per segment.
 */
function hoverCards(html: string): Card[] {
  return html.split('data-card-host="true"').slice(1).map((chunk) => {
    const line = /data-card-command="true">([\s\S]*?)<\/div>/u.exec(chunk)?.[1] ?? ''
    // The clock is the LAST span of the command line, so the command's own text is
    // everything before it.
    const [beforeClock = '', clock = ''] = line.split(/(?=<span[^>]*data-card-time)/u)
    return {
      command: unescape(beforeClock.replace(/<[^>]*>/gu, '')),
      clock: /\[([^\]]*)\]/u.exec(clock.replace(/<[^>]*>/gu, ''))?.[1] ?? null,
      output: /data-card-output="true">([\s\S]*?)<\/pre>/u.exec(chunk)?.[1] ?? null,
      divider: chunk.includes('data-card-divider="true"'),
      // A highlighted run is a span carrying colour; the clock is stripped off above,
      // so every span counted here is a Shiki token.
      tokenSpans: (beforeClock.match(/<span style=/gu) ?? []).length,
    }
  })
}

/** Register the card out of the bundle and render it for one settled call. */
async function renderCard(
  block: Record<string, unknown> = settledBlock(),
  live?: Record<string, unknown>,
  // The tool name picks the highlighting grammar. `shell_progress` is deliberately not
  // one of the two registered tools, so the DEFAULT fixture is the plain-text path; the
  // tests about highlighting pass a real tool name, exactly as the host does.
  toolName = 'shell_progress',
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
    toolName,
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

/** The stylesheets the bundle injects, as one string. */
async function injectedCss(): Promise<string> {
  const entry = await loadBundle()
  entry.factory(loaderRequire)
  return Array.from(document.querySelectorAll('style[data-plugin="dsh-shell-progress"]'))
    .map((node) => node.textContent ?? '')
    .join('\n')
}

/** How many times a shared name is declared (`--name:`) and consumed (`var(--name`). */
function paletteUse(css: string, name: string): { readonly declared: number, readonly consumed: number } {
  return {
    declared: (css.match(new RegExp(`${name}:`, 'g')) ?? []).length,
    consumed: (css.match(new RegExp(`var\\(${name}[,)]`, 'g')) ?? []).length,
  }
}

describe('the built client bundle, rendered', () => {  it('injects one stylesheet per CSS module when the factory runs', async () => {
    const entry = await loadBundle()
    // The factory is what evaluates the modules, and the style tags are
    // injected as a module side effect — so this call is the subject.
    entry.factory(loaderRequire)
    const styles = Array.from(document.querySelectorAll('style[data-plugin="dsh-shell-progress"]'))
    // ONE STYLESHEET PER CSS MODULE, counted: Row, ProgressBar, StepList and SettingsSection.
    // The number is the point — a module that stopped being injected (a typo in an import, a
    // file left out of the bundle) would silently leave a surface unstyled, and nothing else
    // in the suite would notice.
    expect(styles).toHaveLength(4)
    const css = styles.map((node) => node.textContent ?? '').join('\n')
    // The two declarations that make the bar visible. Their absence is the exact
    // regression this suite exists for: a rendered height and a width FLOOR. (The track
    // keeps the 9px the row is measured from; how much of it each bar SHAPE paints is
    // pinned by the shape test below.)
    expect(css).toContain('height:9px')
    expect(css).toContain('min-width:48px')
    // A loaded token, so the segments are not merely transparent. It is the system's own
    // static BLUE, `deepseek-400`: the bar reports how long a command has run, not whether
    // it succeeded (green is the shell's colour for that), and the paler `deepseek-300`
    // left the segment with almost no colour in it.
    expect(css).toContain('--dsw-static-deepseek-400')
  })

  // The bar and the step list are two CSS modules, and the dot's colour has to BE
  // the segment's colour — not a second copy of it. So the state palette is declared
  // exactly once and read from both places. The counts are structural: one
  // declaration, and at least two consumers, one of which is on each side.

  it('declares the step-state palette once and reads it from both the bar and the dots', async () => {
    const css = await injectedCss()
    for (const state of ['pending', 'running', 'done', 'slow', 'error']) {
      const { declared, consumed } = paletteUse(css, `--step-state-${state}`)
      expect(declared, `--step-state-${state} is declared ${String(declared)} times, not once`).toBe(1)
      expect(
        consumed,
        `--step-state-${state} is read by ${String(consumed)} rules — the bar segment and the dot must both read it`,
      ).toBeGreaterThanOrEqual(2)
    }
    // The RUNNING translucency is shared, so a running step reads as the same unfinished
    // material in the list as on the bar. The PENDING one is the bar's alone now: the list's
    // pending dot is deliberately darker and fully opaque, because at the bar's faintness it
    // disappeared into the row (see `--step-state-pending-dot`). This test is the reason that
    // decision had to be written down — it fails the moment the two views stop agreeing.
    for (const state of ['running']) {
      const { declared, consumed } = paletteUse(css, `--step-alpha-${state}`)
      expect(declared, `--step-alpha-${state} is declared ${String(declared)} times, not once`).toBe(1)
      expect(consumed, `--step-alpha-${state} is read by ${String(consumed)} rules`).toBeGreaterThanOrEqual(2)
    }
    const pendingAlpha = paletteUse(css, '--step-alpha-pending')
    expect(pendingAlpha.declared, 'the pending translucency is not declared exactly once').toBe(1)
    expect(pendingAlpha.consumed, 'the pending translucency is the dot\'s again').toBe(1)
    // And how VIVID that palette is painted is shared the same way: declared once, on the
    // card with the colours, and read by all three places that paint a step's state —
    // the segment, the dot and the single-fill bar — because a dot that stayed vivid
    // beside a calmer segment is precisely the drift the palette prevents.
    const saturation = paletteUse(css, '--step-saturation')
    expect(saturation.declared, 'the palette saturation is not declared exactly once').toBe(1)
    expect(
      saturation.consumed,
      `the palette saturation is read by ${String(saturation.consumed)} rules — the segment, the dot and the solid bar must all read it`,
    ).toBe(3)
    expect(css, 'the palette saturation is not the calmer value').toContain('--step-saturation:.7')
    // It is applied as a FILTER, not baked into a colour: every consumer is a
    // `saturate()` on a rule that also paints one of the palette's tokens.
    expect(
      css.match(/filter:saturate\(var\(--step-saturation/gu) ?? [],
      'the saturation is not applied as a filter, so an engine that cannot parse the value would paint a transparent bar',
    ).toHaveLength(3)
  })

  // The removal pins. The `>` marker, the border-drawn caret and its rotation are
  // gone from the shipped stylesheet; the DOM half of the same claim is asserted
  // against a real browser in `e2e/card.spec.ts`.

  it('ships no running arrow, no caret triangle and no open-state rule', async () => {
    const css = await injectedCss()
    // A positive control, so a stylesheet that failed to load cannot pass the
    // absence checks below by being empty.
    expect(css).toContain('--step-marker:8px')
    expect(css).not.toContain('-1.3em')
    expect(css).not.toContain('border-left:5px solid currentColor')
    expect(css).not.toContain('rotate(90deg)')
  })

  // The numbers these changes are about, pinned where they cannot drift: one right
  // inset shared by the progress line and the step list, and an output that starts on
  // the COMMAND TEXT's own column instead of behind an indent of its own.

  it('shares one right inset and puts the output on the command text\'s own column', async () => {
    const css = await injectedCss()
    const inset = paletteUse(css, '--card-pad-right')
    expect(inset.declared, 'the shared right inset is not declared exactly once').toBe(1)
    expect(inset.consumed, 'the shared right inset is not used by BOTH rows').toBe(2)
    expect(css).toContain('--card-pad-right:4px')
    // The output's indent IS the command text's column — the marker, the gap after it
    // and the headline's 1px, read from those names rather than repeated as a literal
    // that could drift away from them.
    const indent = paletteUse(css, '--step-output-indent')
    expect(indent.declared, 'the output indent is not declared exactly once').toBe(1)
    // Read TWICE: by the output block, and by the truncation note under it. The note says
    // what the output is missing, so it belongs on the output's own column rather than at
    // the row's edge — two owners of one number, which is the point of naming it.
    expect(indent.consumed, 'the output indent is not used by the output block AND the truncation note').toBe(2)
    expect(css).toContain('--step-output-indent:calc(var(--step-marker) + var(--step-gap) + 1px)')
    expect(css, 'the output still carries the old deeper 24px indent').not.toContain('--step-output-indent:24px')
    // The gap is what makes that column the command's: declared once, read by the
    // headline that lays the marker out and by the indent built out of it.
    const gap = paletteUse(css, '--step-gap')
    expect(gap.declared, 'the marker gap is not declared exactly once').toBe(1)
    expect(gap.consumed, 'the marker gap is not read by the headline AND by the output indent').toBe(2)
  })

  // The three shapes this change is about, pinned in the SHIPPED stylesheet: a 4px
  // round dot that grows on hover and does not move, no hover fill anywhere, and NO
  // divider in the card body. The rendered halves of the same claims are measured in
  // a real browser by `e2e/card.spec.ts`.

  it('ships a smaller round dot that grows on hover, no hover fill and no card-body divider', async () => {
    const css = await injectedCss()
    const dot = paletteUse(css, '--step-dot')
    expect(dot.declared, 'the dot size is not declared exactly once').toBe(1)
    // Read twice on purpose: once for each axis of the circle.
    expect(dot.consumed, 'the dot size is not read by both of the dot\'s axes').toBe(2)
    // 4px, down from 6px — and 4 × 1.25 is a whole device pixel where 6 × 1.25 is
    // not, which is the whole reason for the size.
    expect(css).toContain('--step-dot:4px')
    expect(css, 'the old 6×6 dot is still in the stylesheet').not.toContain('width:6px;height:6px')
    // Round by construction at any size: the radius, no border to add a second box,
    // and one aspect ratio for the two axes.
    const dotRule = /(?:^|\})\.([A-Za-z0-9_-]*_dot)\{([^}]*)\}/.exec(css)
    expect(dotRule, 'the dot has no rule of its own').not.toBeNull()
    const dotBody = dotRule?.[2] ?? ''
    expect(dotBody, 'the dot is not a circle').toContain('border-radius:50%')
    expect(dotBody, 'the dot can still gain a border box').toContain('border:0')
    expect(dotBody, 'the dot\'s two axes can disagree').toContain('aspect-ratio:1')
    // It grows on hover, as a TRANSFORM about its own centre: nothing here is layout,
    // so neither the marker column nor one character of the command can move.
    expect(css, 'the dot does not grow on hover').toContain('transform:scale(1.5)')
    expect(dotBody, 'a transform sits in the dot\'s resting state, not only on hover').not.toContain('transform:')
    // The hover FILL is gone — in both themes, which means the theme's interactive
    // fill token is gone from this plugin's stylesheets entirely.
    expect(css, 'the row still paints the theme\'s hover fill').not.toContain('--dsw-alias-interactive-bg-hover')
    // A command line still WAITING its turn is not faded either: the pending state is the
    // dot's colour and the bar's segment, and the text is not a state indicator. The rule
    // that dimmed it is gone from the shipped stylesheet, which is the half a browser
    // cannot be asked about from here (the e2e measures the other half).
    expect(css, 'a pending row still fades its command line').not.toMatch(/_headline\{[^}]*opacity/u)
    // NO divider in the card body. The hairline that used to sit above the output is
    // gone — the CARD carries that divider instead, pinned in the hover-card tests
    // below — and so is the output block's own top border, so the removal is a removal
    // rather than a rule that merely stopped painting.
    const outputRule = /(?:^|\})\.([A-Za-z0-9_-]*_output)\{([^}]*)\}/.exec(css)
    expect(outputRule, 'the output has no rule of its own').not.toBeNull()
    const outputBody = outputRule?.[2] ?? ''
    expect(outputBody, 'the card body still draws a divider above the output').not.toContain('border-top')
    // The design system's border step is the CARD's divider token now, and it is used
    // exactly ONCE: a second reference would mean a second hairline came back somewhere
    // the reader is not hovering. Counted, because "the token appears in the stylesheet"
    // is not the claim being made.
    const dividerUses = css.match(/var\(--dsw-alias-border-l3/gu) ?? []
    expect(dividerUses, 'the divider token is used by something other than the card\'s rule').toHaveLength(1)
    expect(outputBody, 'the output is not dimmer than the command').toContain('color:var(--dsw-alias-label-caption')
    expect(outputBody, 'the output still wears the command line\'s own colour').not.toContain('color:var(--dsw-alias-label-primary')
    // The `:empty` rule that existed for the divider is gone with it, and no rule puts room
    // back: the output carries `margin: 0` and no vertical padding, so an output that printed
    // nothing takes no room AND every line in the list — a command, its output, the next
    // command — sits on the same 15px rhythm. It used to carry 3px of margin plus 2px of
    // padding, five times the gap below it, which is what made an output look as if it
    // floated between two steps rather than hanging under its own.
    expect(css, 'the dropped `:empty` rule is still in the stylesheet').not.toMatch(/:empty\{/u)
    expect(outputBody, 'the output spaces itself away from its command again').toContain('margin:0')
    expect(outputBody, 'the output adds space above itself again').not.toContain('padding-top')
    // The BAR is slimmer than its own box, and this is the CSS half of "smaller, with the
    // hot zone intact": the segment clips its paint to the content box and takes 1.5px of
    // top and bottom padding to make the difference, while its box — the pointer target —
    // stays the track's 9px. The pixels themselves are measured in a browser.
    const segmentRule = /_segment\{([^}]*)\}/u.exec(css)
    expect(segmentRule, 'the segment has no rule of its own').not.toBeNull()
    const segmentBody = segmentRule?.[1] ?? ''
    expect(segmentBody, 'the segment paints its padding, so the bar is as tall as its box').toContain('background-clip:content-box')
    expect(segmentBody, 'the segment has no padding for that clip to hide').toContain('padding:3px 0')
    expect(segmentBody, 'the padding would grow the box instead of insetting the paint').toContain('box-sizing:border-box')
    expect(segmentBody, 'the segment no longer fills the track').toContain('height:100%')
    const trackRule = /_track\{([^}]*)\}/u.exec(css)
    expect(trackRule?.[1], 'the track no longer keeps the 9px the row and the card anchor are measured from').toContain('height:9px')
    // The lifted state thickens INSIDE the track now: it takes 1px off the padding top and
    // bottom instead of growing the box past the 9px track, which is what put 1px above and
    // 1px below into the card's scrollable overflow (and a scrollbar in the shell's body).
    // The comment above describes the old 11px box and is kept only as the reason for this.
    const liftRule = /_segment:hover[^{]*\{([^}]*)\}/u.exec(css)
    expect(liftRule?.[1], 'the lifted segment does not thicken by shrinking its own padding').toBe('padding:2px 0')
    // The other bar shape follows the same painted height, so switching shapes does not
    // change how thick the bar looks.
    expect(/_solid\{([^}]*)\}/u.exec(css)?.[1], 'the single-fill bar is not as thin as the segmented one').toContain('height:3px')
  })

  it('draws one segment per step, each with an accessible name, its command and its output', async () => {
    const html = await renderCard()
    expect((html.match(/data-phase="done"/g) ?? [])).toHaveLength(4)
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuemax="4"')
    expect(html).toContain('aria-valuenow="4"')
    // Hovering a segment shows the STEP'S OWN COMMAND, ITS TIME AND ITS OUTPUT — the
    // same things the expanded row shows, one above the other. Its source line number
    // is deliberately NOT in the card: the card points at the matching row instead.
    const cards = hoverCards(html)
    expect(cards, 'the bar did not render one hover card per segment').toHaveLength(4)
    expect(cards[0]?.command, 'the first segment\'s card does not carry its command').toBe('Write-Output "[1/4] fetch"')
    expect(cards[0]?.clock, 'the first segment\'s card does not carry its clock').toBe('0s')
  })

  // The hover card's own half. It is the shell's `HoverCard`, the same primitive the
  // session list's rows use, and its `content` is a ReactNode — which is what makes BOTH
  // of the things the old string bubble could not carry possible: a DIVIDER that is a
  // real element, and a command line that is syntax-highlighted.

  it('puts the step\'s own output in its segment card, under a real divider', async () => {
    const html = await renderCard()
    const cards = hoverCards(html)
    expect(cards, 'the bar did not render one hover card per segment').toHaveLength(4)
    // The command line (with its clock), a divider, then that step's OWN output — for
    // every step, not just the first: each card reads the step it belongs to.
    const steps = [
      { command: 'Write-Output "[1/4] fetch"', output: '[1/4] fetch' },
      { command: 'Write-Output "[2/4] build"', output: '[2/4] build' },
      { command: 'Write-Output "[3/4] test"', output: '[3/4] test' },
      { command: 'Write-Output "[4/4] pack"', output: '[4/4] pack' },
    ]
    cards.forEach((card, index) => {
      const step = steps[index]
      expect(card.command, `segment ${String(index + 1)}'s card is not its own command`).toBe(step?.command)
      expect(card.clock, `segment ${String(index + 1)}'s card lost its clock`).toBe('0s')
      expect(card.divider, `segment ${String(index + 1)}'s card has no divider between the command and the output`).toBe(true)
      expect(card.output, `segment ${String(index + 1)}'s output is not under the divider`).toBe(step?.output)
    })
  })

  it('highlights the command inside the segment card, exactly as the step list does', async () => {
    const cards = hoverCards(await renderCard(settledBlock(), undefined, 'shell_progress_pwsh'))
    // The divider is not the only thing the node form buys: the command is highlighted
    // by language HERE too, because both views render the same `commandContent`. The
    // string bubble this replaced could carry no token span at all — that asymmetry was
    // measured in a browser, and this is the assertion that replaced it.
    expect(cards[0]?.tokenSpans, 'the card\'s command carries no highlighted run').toBeGreaterThan(0)
  })

  // The divider rules the CARD, which is a stylesheet fact rather than a string length:
  // the glyph run the old bubble had to count — with its own floor and ceiling — is gone
  // with the string prop that forced it.
  it('rules the card\'s divider across the card, with no glyph run left', async () => {
    const css = await injectedCss()
    const ruleBody = /_cardRule\{([^}]*)\}/u.exec(css)?.[1] ?? ''
    expect(ruleBody, 'the card has no divider rule of its own').not.toBe('')
    expect(ruleBody, 'the card\'s divider is not a border').toContain('border-top:1px solid var(--dsw-alias-border-l3')
    // `<hr>` ships a full border box in every engine's UA sheet; only the top edge is wanted.
    expect(ruleBody, 'the `<hr>` kept the engine\'s own border box').toContain('border:0')
    expect(css, 'the box-drawing glyph run is still somewhere in the stylesheet').not.toContain('\u2500')
  })

  it('keeps empty, long and markup-bearing output safe in the card', async () => {
    const html = await renderCard(withOutputs([
      '<script>alert("x")</script> & done',
      '',
      Array.from({ length: 12 }, (_, index) => `line ${String(index + 1)}`).join('\n'),
      'x'.repeat(600),
    ]))
    const cards = hoverCards(html)
    expect(cards).toHaveLength(4)
    // Markup characters are characters of a text child: React escapes them, so the output
    // is READ as text and no element is created out of it. Asserted against the RAW
    // markup, which is what keeps the escaping visible rather than undone by a helper.
    expect(cards[0]?.output, 'the output\'s markup characters were not escaped').toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; done',
    )
    expect(html, 'output was rendered as markup').not.toContain('<script>')
    // Empty output draws NO output block and NO divider: a divider with nothing under it
    // would be a rule across nothing.
    expect(cards[1]?.output, 'an empty output still drew an output block').toBeNull()
    expect(cards[1]?.divider, 'an empty output still drew a divider').toBe(false)
    // Long output is clamped by LINE, and says how much it hid: six lines, then the count,
    // so the seventh is never silently missing.
    const clamped = unescape(cards[2]?.output ?? '')
    expect(clamped.split('\n'), 'the card did not clamp a 12-line output to six lines plus a count').toHaveLength(7)
    expect(clamped, 'the card does not say how many lines it hid').toContain('… 6 more lines')
    // ...and one enormous single line is clamped by CHARACTER, so it cannot become a slab
    // taller than the card's own cap.
    const wide = unescape(cards[3]?.output ?? '')
    expect(wide.endsWith('…'), 'a 600-character output line was not clamped').toBe(true)
    expect(wide.length, 'the clamped output is still unbounded').toBeLessThan(500)
  })

  it('puts a real hashed class on the track, so the layout is not unstyled', async () => {
    const html = await renderCard()
    const track = /class="([^"]*)"[^>]*role="progressbar"/.exec(html)
    expect(track).not.toBeNull()
    const classes = track?.[1] ?? ''
    expect(classes.length).toBeGreaterThan(4)
    expect(classes).not.toBe('undefined')
  })

  // The count's SIDE is a property of the markup, not of a stylesheet, so it is
  // pinned here: the count is the last element of the progress line, i.e. it comes
  // AFTER the bar in DOM order. That is what makes it the outermost element — and
  // therefore the right edge the step rows have to meet, which `e2e/card.spec.ts`
  // measures against the row boxes. Swapping the two back would put the count on the
  // left and hand the boundary back to the bar.

  it('renders the count AFTER the bar, so the count is the outermost element', async () => {
    const html = await renderCard()
    // The progress line's opening tag is the boundary: everything from there on is
    // the line's own content, and the line is the last thing this card renders at its
    // own level except the (closed) step list and the notice, both of which come
    // after the count. A `[\s\S]*?</div></div>` capture is deliberately NOT used —
    // the bar nests divs of its own, so the first `</div></div>` closes the bar and
    // the capture would end before the count and pass for the wrong reason.
    const lineAt = html.indexOf('data-progress-line="true"')
    expect(lineAt, 'the progress line has no markup of its own to read').toBeGreaterThan(-1)
    const fromLine = html.slice(lineAt)
    const barAt = fromLine.indexOf('role="progressbar"')
    const counterAt = fromLine.search(/<span class="[^"]*" data-counter="true">/)
    expect(barAt, 'the progress line carries no bar').toBeGreaterThan(-1)
    expect(counterAt, 'the progress line carries no count').toBeGreaterThan(-1)
    expect(barAt, 'the count leads the bar, so the count is not the outermost element').toBeLessThan(counterAt)
    // ...and the count is the element that CLOSES the line: nothing after it in this
    // container. Read on the same slice, so it is the count's position that is pinned
    // rather than a later element's.
    const afterCounter = fromLine.slice(counterAt)
    expect(afterCounter, 'an element still follows the count inside the progress line').not.toContain('data-phase=')
  })

  // The rendered proof for the refusal signal, CURRENT shape. The host reports the refused
  // command as ONE step — the whole command — so the card draws one segment and a counter
  // like any one-line command, and the refusal is said by the `!` in the header. Its
  // explanation lives in a hover card, which a static render cannot open; the browser suite
  // opens it and reads it.

  it('draws one segment, a counter and the untracked mark for a REFUSED call', async () => {
    const html = await renderCard(refusedBlock())
    expect(html).toContain('data-progress-line')
    expect(html).toContain('row.counter')
    expect(
      (html.match(/data-phase="/g) ?? []),
      'the refused card does not draw exactly one segment',
    ).toHaveLength(1)
    expect(html, 'the refused card carries no `!`').toContain('data-untracked="true"')
    // EVERY line of the command, not just the first: an untracked command is one step whose
    // text is the whole multi-line command, and `highlightCommand` tokenises one line.
    expect(html, 'the refused row lost the command\'s second line').toContain('$v: c')
    // No notice: the `!` is the signal, and the lost-output notice is a different thing.
    expect(html).not.toContain('row.partial')
  })

  // A refusal persisted by an OLDER host: no steps at all, so nothing exists to draw a bar
  // from and the card falls back to the plain body. It keeps the `!` — what is missing is the
  // step, not the refusal.
  it('falls back to no bar for a LEGACY refused record whose step list is empty', async () => {
    const html = await renderCard(legacyRefusedBlock())
    expect((html.match(/data-phase=/g) ?? [])).toHaveLength(0)
    expect(html).not.toContain('data-counter')
    expect(html).not.toContain('data-progress-line')
    expect(html).toContain('data-untracked="true"')
  })

  it('keeps the progress line for a single-step command that was merely uninstrumented', async () => {
    const html = await renderCard(singleStepBlock())
    // It is still a card with its own counter, because it WAS tracked: one step, one
    // segment. A single-line command and an untracked one now LOOK the same — that is
    // deliberate — and the `!` is what tells them apart.
    expect(html).toContain('row.counter')
    expect(html).toContain('data-progress-line')
    expect(html, 'a tracked single-step command carries the untracked `!`').not.toContain('data-untracked=')
    // AND it draws its bar. One step is ONE segment, not none: a single-line command
    // used to get a counter and no bar at all, which is the shape this pins.
    expect((html.match(/data-phase="/g) ?? []), 'the single-step card drew no segment').toHaveLength(1)
  })

  // The truncation count. "Something was dropped" is not enough for a reader looking at
  // a step and wondering whether the command was quiet or cut — the amount is the answer.
  // The STEP LIST's copy of this note is measured in a browser instead: a collapsed card
  // renders no step list here, so a claim about that one would be vacuous.
  it('states the dropped characters in a truncated step\'s card, and nothing otherwise', async () => {
    const html = await renderCard(truncatedBlock())
    expect(html, 'the card does not say how much of the output is missing').toContain('row.truncated chars=1234')
    expect(html, 'the card has no truncation marker').toContain('data-card-truncated="true"')
    // A step that lost nothing says nothing: the marker is not decoration.
    const clean = await renderCard(singleStepBlock())
    expect(clean, 'a complete step carries a truncation marker').not.toContain('data-card-truncated=')
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
    // markup either, for a second reason: the CARD's own disclosure is closed by
    // default and a static render never opens it — which is why the row-level pin
    // lives in `./model.spec.ts`, where `view.steps` is read directly, and why the
    // always-rendered output block is measured in a real browser by
    // `e2e/card.spec.ts`.
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

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

/**
 * The four-step settled call with each step's output REPLACED.
 *
 * The tooltip has three edges the four uniform fixture outputs never reach: output
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

/** The bubble's divider glyph, as the shipped bundle draws it. */
const RULE_CHAR = '\u2500'

/**
 * A run of divider glyphs, as it appears on the tooltip's own line.
 * @param count - how many glyphs.
 * @returns the line.
 */
function rule(count: number): string {
  return RULE_CHAR.repeat(count)
}

/**
 * The first tooltip's title out of a rendered card — one segment's bubble.
 * @param html - the rendered card.
 * @returns the title text, or an empty string when no tooltip rendered.
 */
function firstTitle(html: string): string {
  return [...html.matchAll(/title="([^"]*)"/gu)].map((match) => match[1] ?? '')[0] ?? ''
}

/**
 * A settled call whose steps are exactly the given command and output, so the bubble's
 * divider can be measured against text this file chooses instead of the four-step
 * fixture's fixed commands. TWO steps, because a one-step call draws no bar at all
 * (`barShape` returns 'none' at `total <= 1`) and therefore no segment tooltip.
 * @param command - the step's command text.
 * @param output - the output that command produced.
 * @returns the call block.
 */
function twoSteps(command: string, output: string): Record<string, unknown> {
  return {
    ...settledBlock(),
    call: { name: 'shell_progress', argsRaw: JSON.stringify({ command: `${command}\n${command}` }) },
    meta: {
      v: 1,
      instrumented: false,
      refused: false,
      partial: false,
      preamble: '',
      steps: [
        { line: 1, text: command, output, startedAt: 0, endedAt: 0 },
        { line: 2, text: command, output, startedAt: 0, endedAt: 0 },
      ],
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
    expect(styles).toHaveLength(3)
    const css = styles.map((node) => node.textContent ?? '').join('\n')
    // The two declarations that make the bar visible. Their absence is the exact
    // regression this suite exists for.
    expect(css).toContain('height:6px')
    expect(css).toContain('min-width:48px')
    // A loaded token, so the segments are not merely transparent.
    expect(css).toContain('--dsw-alias-state-success-primary')
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
    // The two translucencies are shared the same way, so pending and running read as
    // the same material in the list as they do on the bar.
    for (const state of ['pending', 'running']) {
      const { declared, consumed } = paletteUse(css, `--step-alpha-${state}`)
      expect(declared, `--step-alpha-${state} is declared ${String(declared)} times, not once`).toBe(1)
      expect(consumed, `--step-alpha-${state} is read by ${String(consumed)} rules`).toBeGreaterThanOrEqual(2)
    }
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
    expect(indent.consumed, 'the output indent is not used by the output block').toBe(1)
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
    // NO divider in the card body. The hairline that used to sit above the output is
    // gone — the tooltip carries that divider instead, pinned in the bubble tests
    // below — and the design system's border step is not referenced anywhere, so the
    // removal is a removal rather than a rule that merely stopped painting.
    const outputRule = /(?:^|\})\.([A-Za-z0-9_-]*_output)\{([^}]*)\}/.exec(css)
    expect(outputRule, 'the output has no rule of its own').not.toBeNull()
    const outputBody = outputRule?.[2] ?? ''
    expect(outputBody, 'the card body still draws a divider above the output').not.toContain('border-top')
    expect(css, 'the divider token is still in the stylesheet').not.toContain('--dsw-alias-border-l3')
    expect(outputBody, 'the output is not dimmer than the command').toContain('color:var(--dsw-alias-label-caption')
    expect(outputBody, 'the output still wears the command line\'s own colour').not.toContain('color:var(--dsw-alias-label-primary')
    // The `:empty` rule that existed for the divider is gone with it, and the spacing
    // that keeps an empty output out of the way now hangs on the block that HAS
    // something to show: dropping the rule must not re-open a blank gap under a step
    // that printed nothing.
    expect(css, 'the dropped `:empty` rule is still in the stylesheet').not.toMatch(/:empty\{/u)
    expect(css, 'an empty output would take up blank room again').toMatch(/_output[A-Za-z0-9_-]*:not\(:empty\)\{/u)
  })

  it('draws one segment per step, each with an accessible name, its command and its output', async () => {
    const html = await renderCard()
    expect((html.match(/data-phase="done"/g) ?? [])).toHaveLength(4)
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuemax="4"')
    expect(html).toContain('aria-valuenow="4"')
    // Hovering a segment shows the STEP'S OWN COMMAND, ITS TIME AND ITS OUTPUT — the
    // same things the expanded row shows, one above the other. Its source line number
    // is deliberately NOT in the bubble: the card points at the matching row instead.
    expect(html).toContain('title=')
    expect(html).toContain('[1/4] fetch')
    expect(html).toContain('[0s]')
  })

  // The bubble's new half. The shell's own bubble is `white-space: pre-line`, so a
  // `\n` in the label is the line break the reader sees — and the label is a STRING
  // rendered as a text child, so nothing in the output can become markup, and no
  // DIVIDER can be an element either. The stub in this file renders that label into a
  // `title` attribute, which is the same string.

  it('puts the step\'s own output in its segment tooltip, under a divider', async () => {
    const html = await renderCard()
    const titles = [...html.matchAll(/title="([^"]*)"/gu)].map((match) => match[1] ?? '')
    expect(titles, 'the bar did not render one tooltip per segment').toHaveLength(4)
    // Command line (with the clock) first, then the divider, then the step's output.
    // 31 glyphs is the widest line here — the command with its clock — because the
    // shell's `Tooltip` takes a string and can carry no element that could draw a rule.
    expect(titles[0], 'the first step\'s tooltip is not its command, a divider and its output').toBe(
      `Write-Output &quot;[1/4] fetch&quot; [0s]\n${rule(31)}\n[1/4] fetch`,
    )
    // The third step's command is one character shorter (`test`, not `fetch`), so its
    // rule is one glyph shorter: the divider follows the text it separates.
    expect(titles[2], 'the third step\'s tooltip is not its own command, a divider and its output').toBe(
      `Write-Output &quot;[3/4] test&quot; [0s]\n${rule(30)}\n[3/4] test`,
    )
    // The divider is its OWN line between the two, not a prefix on the output: line 2
    // is nothing but box-drawing glyphs, and the output follows on line 3. The widths
    // are the widest line in each bubble — the command with its clock, 31 characters
    // for `fetch`/`build` and 30 for `test`/`pack`.
    const steps = [
      { output: '[1/4] fetch', divider: 31 },
      { output: '[2/4] build', divider: 31 },
      { output: '[3/4] test', divider: 30 },
      { output: '[4/4] pack', divider: 30 },
    ]
    titles.forEach((title, index) => {
      const lines = title.split('\n')
      expect(lines[1], `segment ${String(index + 1)} has no divider line`).toMatch(/^\u2500+$/u)
      expect(lines[1]?.length, `segment ${String(index + 1)}'s divider is not sized to the widest line`).toBe(steps[index]?.divider)
      expect(lines[2], `segment ${String(index + 1)}'s output is not under the divider`).toBe(steps[index]?.output)
    })
  })

  it('sizes the tooltip divider to the widest line, with a floor and a ceiling', async () => {
    // A one-character command: the clock still rides on the line, and the rule stops at
    // its floor rather than shrinking to a stray dash.
    const short = await renderCard(twoSteps('x', 'y'))
    expect(firstTitle(short).split('\n')[1], 'the divider shrank below its floor').toBe(rule(8))
    // A command far past the ceiling: the rule is capped, so a long line cannot turn
    // the bubble into a slab.
    const long = await renderCard(twoSteps('z'.repeat(300), 'w'))
    expect(firstTitle(long).split('\n')[1], 'the divider grew past its ceiling').toBe(rule(48))
  })

  it('keeps empty, long and markup-bearing output safe in the tooltip', async () => {
    const html = await renderCard(withOutputs([
      '<script>alert("x")</script> & done',
      '',
      Array.from({ length: 12 }, (_, index) => `line ${String(index + 1)}`).join('\n'),
      'x'.repeat(600),
    ]))
    const titles = [...html.matchAll(/title="([^"]*)"/gu)].map((match) => match[1] ?? '')
    expect(titles).toHaveLength(4)
    // Markup characters are characters of a string child: React escapes them, so the
    // output is READ as text and no element is created out of it.
    expect(titles[0], 'the output\'s markup characters were not escaped').toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; done',
    )
    expect(html, 'output was rendered as markup').not.toContain('<script>')
    // Empty output adds NO second line — not a blank one — and so no divider either:
    // a divider with nothing under it would be a rule across nothing.
    expect(titles[1], 'an empty output left a dangling line in the bubble').toBe(
      'Write-Output &quot;[2/4] build&quot; [0s]',
    )
    // Long output is clamped by LINE, and says how much it hid: the command line, the
    // divider, six output lines, then the count line — so line nine is never silently
    // missing. (The divider is the one line this change added inside the bubble.)
    expect(titles[2]?.split('\n'), 'the tooltip did not clamp a 12-line output to six lines plus a count').toHaveLength(9)
    expect(titles[2]?.split('\n')[1], 'the clamped bubble lost its divider').toBe(rule(30))
    expect(titles[2], 'the tooltip does not say how many lines it hid').toContain('… 6 more lines')
    // ...and one enormous single line is clamped by CHARACTER, so it cannot become a
    // slab taller than the viewport.
    expect(titles[3]?.endsWith('…'), 'a 600-character output line was not clamped').toBe(true)
    expect((titles[3] ?? '').length, 'the clamped tooltip is still unbounded').toBeLessThan(500)
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

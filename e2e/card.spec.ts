/**
 * The card, in a real browser, against a real `dsh web`.
 *
 * This exists because "does it look like the native tool row?" cannot be answered
 * in Node: the published `ui-primitives` cannot even be imported there (it pulls
 * its own CSS and a transitive surface the shell's module table answers), and the
 * two bugs that reached the screen — a bar collapsed to zero width inside a
 * wrapper, and a chevron on the wrong side — were invisible to every unit test
 * and obvious in one screenshot.
 *
 * The route to a tool card without a model: a fixture cordis plugin, mounted only
 * in this throwaway profile, publishes ONE live session holding a fabricated
 * `pwsh` call and a fabricated `shell_progress` call. The real client renders both
 * cards from real session data, and this spec measures them and photographs them.
 *
 * ## Why it measures the DOM instead of asserting "visible"
 *
 * A collapsed transcript row keeps its layout box and is hidden with
 * `visibility: hidden`, and Playwright's visibility check then reports "hidden"
 * for a row that a locator resolves, that has a box, and that the shell is merely
 * displaying collapsed. Chasing that through the shell's own disclosure toggles
 * cost several rounds: their DOM shape belongs to the shell, not to this plugin.
 * So the assertions read the DOM — segment count and the bar's measured width are
 * the authoritative answers to "was the bar laid out, and is it wide enough to
 * see" — and the screenshots remain the human/visual check.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  bootstrapHome,
  makeFixture,
  repoRoot,
  resolveDsh,
  startHost,
  stopHost,
  tail,
  type Fixture,
  type Host,
} from './helpers/host.ts'

/** The fixture's own id and the call ids it publishes. */
const SESSION_ID = 'e2e-shell-progress'
const PROGRESS_CALL = 'call-progress-1'
const NATIVE_CALL = 'call-pwsh-1'
/** A call whose turn never ends, so its card renders in the RUNNING arm. */
const RUNNING_CALL = 'call-running-1'
const MARKER = 'SHELL_PROGRESS_E2E_SESSION='

/** One step's segment count and the numbers that decide "is this laid out". */
interface Metrics {
  readonly top: number
  readonly height: number
  readonly width: number
  readonly segments: number
  readonly barTop: number
  readonly barWidth: number
  readonly barHeight: number
  readonly text: string
}

/** Where the screenshots land, so they outlive the run and can be looked at. */
const SHOT = join(repoRoot, 'test-results', 'shell-progress-card.png')

const dsh = resolveDsh()

test.describe.configure({ mode: 'serial' })

test.describe('the shell_progress card in a real shell', () => {
  test.skip(dsh === undefined, 'no `dsh` executable: set DSH_BIN or install @deepseek-ai/dsh')
  test.setTimeout(420_000)

  let fixture: Fixture
  let host: Host

  test.beforeAll(async () => {
    // The shell serves the BUILT bundle, never the source: a stale or missing
    // `lib/` shows up as "the card never appears", which reads like a rendering
    // bug and is not one.
    if (!existsSync(join(repoRoot, 'lib', 'client.js'))) {
      throw new Error('lib/client.js is missing — run `pnpm run build` before `pnpm run e2e`')
    }
    fixture = makeFixture('card')
    // First boot on a fresh home creates the profile; bootstrapHome then adds
    // this plugin to it exactly as a user's profile carries it.
    await bootstrapHome(dsh!, fixture)
    // Second boot: the plugin is live, and the fixture overlay publishes the
    // session this spec looks at.
    host = await startHost(dsh!, fixture.home, fixture.workspace, fixture.logFile, [
      '--patch',
      join(repoRoot, 'e2e', 'fixtures', 'profile.patch.yml'),
    ])
  })

  test.afterAll(async () => {
    if (host !== undefined) await stopHost(host.proc)
    fixture?.cleanup()
  })

  test('draws a native-height row with a real bar, one segment per step', async ({ page }) => {
    const sessionId = await waitForMarker(host.logFile, MARKER, 60_000)
    expect(sessionId, `the fixture never announced its session:\n${tail(host.logFile)}`).toBe(SESSION_ID)

    // There is no session deep link: the open session is a persisted client
    // store, seeded before the app boots. Each run gets a fresh random port, so
    // this origin — and therefore this localStorage — is new every time.
    await page.addInitScript((id) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
    }, sessionId)

    await page.goto(host.url, { waitUntil: 'domcontentloaded' })

    // Both cards are in the transcript: the plugin's, and the native one it has
    // to sit beside without standing out.
    const card = page.locator(`[data-chat-call-id="${PROGRESS_CALL}"]`)
    const native = page.locator(`[data-chat-call-id="${NATIVE_CALL}"]`)
    await expect(card, 'the fixture session never rendered').toBeAttached({ timeout: 90_000 })
    await expect(native).toBeAttached()

    // Best effort: open whatever the shell has collapsed, so the pictures show
    // the cards rather than a summary row.
    await expandTranscript(page)
    await revealCard(card)
    await card.scrollIntoViewIfNeeded().catch(() => {})

    const mine = await metricsOf(card)
    const reference = await metricsOf(native)
    console.log(`[e2e] shell_progress ${JSON.stringify(mine)}`)
    console.log(`[e2e] pwsh          ${JSON.stringify(reference)}`)

    await page.screenshot({ path: SHOT, fullPage: true })

    // One segment per top-level step: the fixture's command has four.
    expect(mine.segments, `the card rendered no segments:\n${mine.text}`).toBe(4)
    // A bar that collapsed to zero width is exactly the regression that once
    // reached the screen, and it is invisible to a count-only assertion.
    expect(mine.barWidth, 'the progress bar has no width').toBeGreaterThan(48)
    expect(mine.barHeight, 'the progress bar has no height').toBeGreaterThan(3)
    // THE bar belongs on its OWN line under the header. It once rendered inline
    // beside the title (the disclosure's `collapsedContent` slot is documented as
    // inline), which is the difference this measures directly.
    expect(
      mine.barTop - mine.top,
      `the bar starts ${String(mine.barTop - mine.top)}px into the card — it is not on its own line`,
    ).toBeGreaterThanOrEqual(20)
    // And the card stays compact while doing it: a header plus one progress line,
    // not a second box bolted onto the row. The native row is 24px; 48 leaves room
    // for the progress line and nothing else.
    expect(mine.height, 'the card is taller than a header plus one line').toBeLessThanOrEqual(48)
    expect(reference.height, 'the native row is not the 24px row this compares against').toBeLessThanOrEqual(28)

    // Expanded: each step's own code and its own output, asserted against the
    // DOM because the shell hides a collapsed body rather than unmounting it.
    // The click anchors on `shell_progress`, which the title carries in EVERY
    // locale — an earlier version matched the Chinese title and failed whenever
    // the throwaway boot came up in English.
    const body = page.locator(`[data-chat-call-id="${PROGRESS_CALL}"]`)
    await body.getByText('shell_progress').first().click({ timeout: 10_000 }).catch(() => {})
    await revealCard(card)
    await page.screenshot({ path: SHOT.replace('.png', '-expanded.png'), fullPage: true })
    const expanded = await page.locator(`[data-chat-call-id="${PROGRESS_CALL}"]`).evaluate(
      (node) => (node.textContent ?? ''),
    )
    expect(expanded).toContain('[1/4] fetch')

    // Hover answers "which line is this segment?", and it answers with a
    // BACKGROUND TINT — the `>` marker belongs to the RUNNING step instead, so a
    // settled card shows no arrow at all, not even while hovering. Both halves are
    // measured here rather than eyeballed.
    const segments = card.locator('[role="progressbar"] [data-phase]')
    const arrow = card.locator('[data-arrow]').first()
    const firstRow = arrow.locator('..')
    const firstCode = card.locator('[data-code]').first()
    const arrowOpacity = async (): Promise<string> =>
      await arrow.evaluate((node) => getComputedStyle(node).opacity)
    // The hover fill lives on the command LINE, not the node: with a child open, a
    // background over the whole node would highlight output the pointer is nowhere
    // near. So this measures the headline.
    const rowBackground = async (): Promise<string> =>
      await card.locator('[data-headline]').first().evaluate((node) => getComputedStyle(node).backgroundColor)
    const codeLeft = async (): Promise<number> => (await firstCode.boundingBox())?.x ?? -1

    const beforeOpacity = await arrowOpacity()
    const beforeBackground = await rowBackground()
    const before = await codeLeft()
    await segments.first().hover()
    await page.waitForTimeout(200)
    const afterOpacity = await arrowOpacity()
    const afterBackground = await rowBackground()
    const after = await codeLeft()
    console.log(`[e2e] arrow ${beforeOpacity} -> ${afterOpacity}; row bg ${beforeBackground} -> ${afterBackground}; code x ${String(before)} -> ${String(after)}`)

    // No step of this settled fixture is running, so `>` stays hidden — including
    // through the hover. It marks the executing step, not the pointed-at one.
    expect(beforeOpacity, 'the running marker is shown on a settled card').toBe('0')
    expect(afterOpacity, 'the running marker follows the pointer').toBe('0')
    // The hover highlight IS the answer to hovering, and it is a background change.
    expect(afterBackground, 'hovering a segment did not highlight the matching row').not.toBe(beforeBackground)
    // And it must not move any text: no margin or padding takes part in it.
    expect(after, 'the hover highlight moved the command text').toBe(before)

    // Hovering a segment LIFTS it — the bar's own answer to the pointer, and the cue
    // it wears when the LIST points at it. Pure vertical: no segment may ever change
    // width because of it.
    await page.mouse.move(0, 0)
    await page.waitForTimeout(120)
    const flatSegment = (await segments.first().boundingBox())?.height ?? 0
    await segments.first().hover()
    await page.waitForTimeout(120)
    const liftedSegment = (await segments.first().boundingBox())?.height ?? 0
    console.log(`[e2e] segment height ${String(flatSegment)} -> ${String(liftedSegment)} on hover`)
    expect(liftedSegment, 'hovering a segment did not lift it').toBeGreaterThan(flatSegment)

    // The command and its time must render in the SAME face: they are one line of
    // terminal text, and a different font for the clock makes it read as a separate
    // column instead of part of the line. Measured, not assumed — dropping a `font:`
    // shorthand and keeping only the family is exactly how the weight changes silently.
    const fontOf = async (selector: string): Promise<string> =>
      await card.locator(selector).first().evaluate((node) => {
        const style = getComputedStyle(node)
        return `${style.fontFamily}|${style.fontSize}|${style.fontWeight}`
      })
    const codeFont = await fontOf('[data-code]')
    const timeFont = await fontOf('[data-time]')
    console.log(`[e2e] font code ${codeFont} / time ${timeFont}`)
    expect(timeFont, 'the time renders in a different font from its command').toBe(codeFont)

    // The command line is HIGHLIGHTED by language, and in the SHELL'S token colours:
    // each run must be a span whose colour is a `--shiki-*` custom property, which keeps
    // theming — the dark overrides included — the theme's business rather than ours.
    // `:not([data-time])` because the clock now lives inside the command's own text flow
    // (that is what keeps it glued to the last character), so a bare `span` query would
    // count it as a token: it carries no colour and would add an empty entry to what is
    // supposed to be a list of highlighted runs.
    const tokenColours = await card.locator('[data-code]').first().evaluate((node) =>
      Array.from(node.querySelectorAll('span:not([data-time])')).map((span) => (span as HTMLElement).style.color))
    console.log(`[e2e] command token colours ${JSON.stringify(tokenColours)}`)
    expect(tokenColours.length, 'the command line has no highlighted runs').toBeGreaterThan(0)
    expect(
      tokenColours.some((colour) => colour.startsWith('var(--shiki-')),
      'the token colours are not the theme\'s --shiki-* properties',
    ).toBe(true)

    // The hover fill is a THEME TOKEN, not a fixed colour — the theme defines it
    // twice (`#2631480f` for light, `#ffffff14` for dark). So flipping the shell's
    // own dark-theme attribute must change what the row actually PAINTS: that is
    // the difference between reading the token list and knowing it applies.
    const darkBackground = await page.evaluate(() => {
      document.body.setAttribute('data-ds-dark-theme', '')
      const row = document.querySelector('[data-headline]')
      const value = row === null || row === undefined ? '' : getComputedStyle(row).backgroundColor
      document.body.removeAttribute('data-ds-dark-theme')
      return value
    })
    console.log(`[e2e] hover bg light ${afterBackground} vs dark ${darkBackground}`)
    expect(darkBackground, 'the hover fill does not follow the theme').not.toBe(afterBackground)
    expect(darkBackground, 'the dark-theme fill is not a light tint').toMatch(/^rgba\(255, 255, 255/)

    // The link is TWO-WAY: pointing at a LINE lights its segment. The gutter the
    // highlight needs is carried by EVERY row (`margin: 0 -6px` cancelling
    // `padding: 1px 6px`), so the text must still not have moved for that either.
    const firstSegment = segments.first()
    const linkedState = async (): Promise<string | null> => await firstSegment.getAttribute('data-linked')
    // Park the pointer first: the segment hovered above is still linked, and that
    // the link CLEARS on mouse-out is part of what this checks.
    await page.mouse.move(0, 0)
    await page.waitForTimeout(150)
    expect(await linkedState(), 'the link survived the pointer leaving').toBeNull()
    // STRICT pixel consistency, checked at a FRACTIONAL ratio. At 1.25 a 1px CSS gap
    // is 1.25 physical pixels, and the browser snaps that one way in one place and the
    // other way a few pixels along — which is why `ProgressBar` computes the geometry
    // in device pixels. Three things are asserted per ratio:
    //
    //   * every segment is a WHOLE number of device pixels wide,
    //   * every seam is exactly one device pixel,
    //   * each segment starts a whole number of device pixels after the first.
    //
    // Deliberately NOT asserted: that a segment's absolute page x is integral. The bar
    // starts at x = 500.09375 because that is where the transcript's own layout puts
    // it, and no plugin can move its own container onto a device pixel.
    const geometryAt = async (ratio: number): Promise<{
      widthsOnPixels: boolean
      offsetsOnPixels: boolean
      seams: number[]
      widths: number[]
    }> => {
      await page.evaluate((value) => {
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value })
        window.dispatchEvent(new Event('resize'))
      }, ratio)
      await page.waitForTimeout(250)
      return await segments.evaluateAll((nodes, value) => {
        const boxes = nodes.map((node) => {
          const rect = node.getBoundingClientRect()
          return { start: rect.x * value, width: rect.width * value }
        })
        const whole = (number_: number): boolean => Math.abs(number_ - Math.round(number_)) < 0.05
        const first = boxes[0]?.start ?? 0
        return {
          widthsOnPixels: boxes.every((box) => whole(box.width)),
          offsetsOnPixels: boxes.every((box) => whole(box.start - first)),
          seams: boxes.slice(1).map((box, index) =>
            box.start - ((boxes[index]?.start ?? 0) + (boxes[index]?.width ?? 0))),
          widths: boxes.map((box) => box.width),
        }
      }, ratio)
    }

    for (const ratio of [1, 1.25]) {
      const { widthsOnPixels, offsetsOnPixels, seams, widths } = await geometryAt(ratio)
      const round2 = (values: number[]): number[] => values.map((value) => Math.round(value * 100) / 100)
      console.log(`[e2e] dpr ${String(ratio)}: widths ${JSON.stringify(round2(widths))} (whole=${String(widthsOnPixels)}); offsets whole=${String(offsetsOnPixels)}; seams ${JSON.stringify(round2(seams))}`)
      expect(widthsOnPixels, `segment widths are not whole device pixels at dpr ${String(ratio)}`).toBe(true)
      expect(offsetsOnPixels, `segment offsets are not whole device pixels at dpr ${String(ratio)}`).toBe(true)
      for (const seam of seams) {
        expect(Math.abs(seam - 1), `a seam is ${String(seam)} device px at dpr ${String(ratio)}`).toBeLessThan(0.05)
      }
    }
    // grows taller, the row takes the background fill. Starting from the LINE this
    // time, so the bar side is reached through the link rather than the pointer.
    const segmentHeight = async (): Promise<number> => (await firstSegment.boundingBox())?.height ?? 0
    const beforeRowHover = await codeLeft()
    const beforeLinkedHeight = await segmentHeight()
    await firstRow.hover()
    await page.waitForTimeout(150)
    const afterRowHover = await codeLeft()
    const afterLinkedHeight = await segmentHeight()
    console.log(`[e2e] line hover -> segment linked=${String(await linkedState())}; segment height ${String(beforeLinkedHeight)} -> ${String(afterLinkedHeight)}; code x ${String(beforeRowHover)} -> ${String(afterRowHover)}`)
    expect(await linkedState(), 'hovering a line did not light its segment').toBe('true')
    expect(afterLinkedHeight, 'hovering a line did not lift its segment').toBeGreaterThan(beforeLinkedHeight)
    expect(afterRowHover, 'the row gutter moved the command text').toBe(beforeRowHover)

    // The list is a TREE. Every node starts CLOSED, its marker opens exactly that
    // node's output child, and the marker turns to point down while it is open. The
    // marker is a DRAWN triangle, so its state is its transform, not its text.
    const toggle = card.locator('[data-toggle]').first()
    const node = toggle.locator('../..') // marker -> command line -> node
    const childCount = async (): Promise<number> => await node.locator('[data-output]').count()
    const caretAngle = async (): Promise<string> =>
      await toggle.locator('span').first().evaluate((element) => getComputedStyle(element).transform)
    expect(await caretAngle(), 'a closed node does not start with a right-pointing triangle').toBe('none')
    expect(await childCount(), 'a node shows its child before being opened').toBe(0)
    await toggle.click()
    await page.waitForTimeout(120)
    expect(await caretAngle(), 'the triangle did not turn to point down').toContain('matrix')
    expect(await childCount(), 'opening the marker did not reveal the child').toBe(1)
    await toggle.click()
    await page.waitForTimeout(120)
    expect(await caretAngle(), 'the triangle did not turn back').toBe('none')
    expect(await childCount(), 'closing the marker did not hide the child again').toBe(0)

    // Three things a wrapped command used to get wrong, all measured rather than eyeballed.
    //
    // 1. The caret column is an ABSOLUTE width. It was `ch`, and `ch` resolves against the
    //    element's OWN font — the toggle is a `<button>`, which does not inherit the page
    //    font — so the button and the spacer came out different widths and a command's
    //    left edge moved depending on whether its node had a caret.
    // 2. Every command starts at the same x, caret or no caret.
    // 3. The caret is centred on the FIRST LINE, not on the whole command, so a wrapped
    //    command does not leave it floating beside the last line.
    const marker = await card.locator('[data-toggle]').first().evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { width: getComputedStyle(element).width, centre: rect.top + rect.height / 2 }
    })
    const codeEdges = await card.locator('[data-code]').evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().x))
    const firstLineCentre = await card.locator('[data-code]').first().evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.top + Number.parseFloat(getComputedStyle(element).lineHeight) / 2
    })
    const edgeSpread = Math.max(...codeEdges) - Math.min(...codeEdges)
    console.log(`[e2e] marker width ${marker.width}; command left edge spread ${String(edgeSpread.toFixed(2))}px; caret centre ${marker.centre.toFixed(2)} vs first line centre ${firstLineCentre.toFixed(2)}`)
    expect(codeEdges.length, 'no command line rendered, so nothing was measured').toBeGreaterThan(1)
    expect(marker.width, 'the caret column is not the marker width').toBe('8px')
    expect(edgeSpread, 'commands do not all start at the same x').toBeLessThan(0.5)
    expect(Math.abs(marker.centre - firstLineCentre), 'the caret is not centred on the first line').toBeLessThan(1)

    // The bar no longer navigates: its segments are for READING progress, so a click on
    // one must leave the tree exactly as it was. Scoped to `[data-step]`, because the
    // shell's OWN expanded header row also carries a `data-open` attribute — matching it
    // would have made this assertion compare 1 with 1 and prove nothing.
    const openNodes = async (): Promise<number> => await card.locator('[data-step][data-open]').count()
    const openBefore = await openNodes()
    await segments.nth(2).click()
    await page.waitForTimeout(200)
    console.log(`[e2e] tree open nodes ${String(openBefore)} -> ${String(await openNodes())} after a segment click`)
    expect(openBefore, 'the tree was not back to all-closed before the click').toBe(0)
    expect(await openNodes(), 'clicking a segment changed the tree').toBe(0)

    // The RUNNING arm, in a real browser.
    //
    // Its LIVE numbers need a real call, which this fixture cannot produce: a
    // running call has no host record to answer for. What it pins is the ABSENCE
    // of a guess. The browser cannot run a parser, so before the host answers
    // there must be no bar and no segments at all — the card shows its own row
    // and waits for data. (It used to draw one pending segment per line of a
    // client-side heuristic split here, which is the guess C-6 removed.)
    const running = page.locator(`[data-chat-call-id="${RUNNING_CALL}"]`)
    await expect(running, 'the fixture never rendered a running card').toBeAttached({ timeout: 60_000 })
    await revealCard(running)
    await page.waitForTimeout(2_000)
    await page.screenshot({ path: SHOT.replace('.png', '-running.png'), fullPage: true })
    const planned = await running.evaluate((node) => ({
      bars: node.querySelectorAll('[role="progressbar"]').length,
      phases: [...node.querySelectorAll('[data-phase]')].map((segment) => segment.getAttribute('data-phase')),
      text: (node.textContent ?? '').replace(/\s+/g, ' '),
    }))
    console.log(`[e2e] running ${JSON.stringify(planned)}`)
    // Nothing measured, because nothing was guessed: no bar, no segments.
    expect(planned.bars, `the running card drew a bar before the host answered:\n${planned.text}`).toBe(0)
    expect(planned.phases, `the running card drew ${String(planned.phases.length)} guessed segments`).toHaveLength(0)
  })
})

/**
 * Measure one call row: the numbers that decide whether the card is laid out.
 * @param call - the located call row.
 * @returns its box, its segment count and its bar's box.
 */
async function metricsOf(call: import('@playwright/test').Locator): Promise<Metrics> {
  return await call.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const bar = node.querySelector('[role="progressbar"]')
    const barBox = bar === null ? undefined : bar.getBoundingClientRect()
    return {
      top: Math.round(box.top),
      height: Math.round(box.height),
      width: Math.round(box.width),
      segments: node.querySelectorAll('[data-phase]').length,
      barTop: barBox === undefined ? 0 : Math.round(barBox.top),
      barWidth: barBox === undefined ? 0 : Math.round(barBox.width),
      barHeight: barBox === undefined ? 0 : Math.round(barBox.height),
      text: (node.textContent ?? '').slice(0, 200),
    }
  })
}

/**
 * Open whatever the shell has collapsed in the conversation column.
 *
 * Best effort by design: the shell's disclosure controls are not this plugin's
 * contract, so nothing here is asserted. Only elements that ADVERTISE themselves
 * as collapsed are clicked — a blind click flips whatever the toggle currently
 * is, which collapses a transcript that was already open.
 * @param page - the page holding the transcript.
 */
async function expandTranscript(page: import('@playwright/test').Page): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    const collapsed = page.locator('[aria-expanded="false"]')
    const boxes = await collapsed.evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect()
      return { x: box.x, width: box.width, height: box.height }
    }))
    const index = boxes.findIndex((box) => box.width > 0 && box.height > 0 && box.x > 300)
    if (index < 0) return
    await collapsed.nth(index).click({ timeout: 5_000 }).catch(() => {})
    await page.waitForTimeout(150)
  }
}

/**
 * Lift `visibility: hidden` from the card and its ancestors.
 *
 * A collapsed row keeps its layout box, so this only affects whether it PAINTS.
 * The shell's collapse gesture is not under test here; the card is.
 * @param card - the located call row.
 */
async function revealCard(card: import('@playwright/test').Locator): Promise<void> {
  await card.evaluate((node) => {
    let current: Element | null = node
    while (current !== null) {
      const style = getComputedStyle(current)
      const element = current as HTMLElement
      if (style.visibility === 'hidden') element.style.visibility = 'visible'
      if (style.display === 'none') element.style.display = 'block'
      if (style.opacity === '0') element.style.opacity = '1'
      current = current.parentElement
    }
  })
}

/**
 * Wait for one marker line to appear in a log file.
 * @param file - the log to poll.
 * @param marker - the prefix to look for.
 * @param budgetMs - how long to wait.
 * @returns the marker's value, or undefined when it never arrived.
 */
async function waitForMarker(file: string, marker: string, budgetMs: number): Promise<string | undefined> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (existsSync(file)) {
      const line = readFileSync(file, 'utf8').split('\n').find((entry) => entry.includes(marker))
      if (line !== undefined) return line.slice(line.indexOf(marker) + marker.length).trim()
    }
    if (Date.now() >= deadline) return undefined
    await sleep(300)
  }
}

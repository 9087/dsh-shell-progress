/**
 * Throwaway-boot fixture: publish ONE live session carrying a fabricated `pwsh`
 * call and a fabricated `shell_progress` call, so the real client renders this
 * plugin's card from real session data — without a model, a key, or a network.
 *
 * Mounted only in the e2e profile, as a `--patch` overlay insert row whose name
 * is `./seed-session.mjs`: `dsh-app-boot` rewrites a relative inserted name to a
 * `file://` URL beside the patch file, so this needs no package, no build and no
 * `node_modules` link.
 *
 * Two facts about the host that the shape below depends on:
 *
 * - `ctx.sessions.create()` publishes a LIVE session. The in-memory store does
 *   not persist — "the agent lifecycle attaches a session-log writer to each
 *   published session's write handle; a session published outside that lifecycle
 *   persists nothing" — so a fixture-created session IS served to the client and
 *   is NEVER on disk. The session id is therefore printed to stdout, and the test
 *   reads it back from the host log rather than watching the sessions directory.
 * - `header.cwd` is mandatory in practice: the web client's follow rejects a
 *   cwd-less session as "not found". Hence `meta.cwd`, absolute, from the
 *   environment the harness exports.
 */

import { existsSync } from 'node:fs'

/** Cordis plugin name; shows up in the host log. */
export const name = 'e2e-seed-session'

/** Host services this plugin needs before `apply` runs. */
export const inject = ['sessions', 'tools']

/** Stable id, so a reload finds and reuses the same session. */
const SESSION_ID = 'e2e-shell-progress'

/** The session's workspace root; the harness exports it for exactly this. */
const CWD = process.env.DSH_E2E_WORKSPACE ?? process.cwd()

/** The marker line the test waits for in the host log. */
export const MARKER = 'SHELL_PROGRESS_E2E_SESSION='

/**
 * One text-only tool-result message.
 * @param callId - the call this result answers.
 * @param text - the model-visible output.
 * @returns a `tool` role message.
 */
function toolMessage(callId, text) {
  return {
    id: `msg-${callId}`,
    role: 'tool',
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId },
    toolCallId: callId,
  }
}

/** The command the card under test reports, and the steps its meta carries. */
const COMMAND = [
  'Write-Output "[1/4] fetch"',
  'Write-Output "[2/4] build"',
  'Write-Output "[3/4] test"',
  'Write-Output "[4/4] pack"',
].join('\n')

/** The language the host renders in; the seeded notes are the only ones a test can see. */
const LOCALE = process.env.DSH_E2E_LOCALE ?? 'zh'

/**
 * The seeded notes, one per annotated step, IN THE HOST'S LANGUAGE.
 *
 * The fixture has no model, so these are the only notes any test — and any README figure —
 * can see. They follow the host locale because the figure of the English README must not
 * carry Chinese annotations: `DSH_E2E_LOCALE` is set by the figure hosts for exactly this.
 */
const NOTES = LOCALE === 'en'
  ? ['Fetch the dependencies into the local cache', 'Compile the output into dist']
  : ['拉取依赖并写入本地缓存', '编译产物到输出目录']

/** The persisted presentation metadata, in the shape the card reads. */
const PROGRESS_META = {
  v: 1,
  instrumented: true,
  partial: false,
  preamble: '',
  steps: [
    // `note` on the first two steps and absent on the last two ON PURPOSE: the card must
    // draw the model's line where there is one and NOTHING where there is not (a blank
    // comment line would be worse than no note), and the e2e asserts both halves.
    { line: 1, text: 'Write-Output "[1/4] fetch"', output: '[1/4] fetch', note: NOTES[0], startedAt: 0, endedAt: 1_200 },
    { line: 2, text: 'Write-Output "[2/4] build"', output: '[2/4] build', note: NOTES[1], startedAt: 1_200, endedAt: 6_400 },
    { line: 3, text: 'Write-Output "[3/4] test"', output: '[3/4] test', startedAt: 6_400, endedAt: 7_600 },
    { line: 4, text: 'Write-Output "[4/4] pack"', output: '[4/4] pack', startedAt: 7_600, endedAt: 8_000 },
  ],
}

/** The summary line for the figure card, in the host's language, like the live demos. */
const FIGURE_DESCRIPTION = LOCALE === 'en' ? 'four-step build demo' : '四步构建演示'

/**
 * The call id of the SETTLED card the README's HOVER figure is shot from.
 *
 * It is published in the OPEN turn rather than reusing `call-progress-1`: the shell folds the
 * first turn away in the figure context, and a hover cannot land on a card that is not on
 * screen. Same command, same metadata, same notes — only the position differs.
 */
const FIGURE_CALL = 'call-figure-hover-1'

/**
 * A call whose step list does NOT fit the box that shows it — the scroll strip's own
 * fixture.
 *
 * Thirty statements make the expanded card taller than both boxes the shell can hand the
 * wheel to (its page scroller, and a folded turn's ~400px process box), so at least one of the
 * strip's two buttons must be enabled the moment the card opens. It is published in the OPEN
 * turn so a test can expand it without unfolding a finished turn first.
 */
const LONG_CALL = 'call-long-1'
const LONG_COMMAND = Array.from(
  { length: 30 },
  (_, index) => `Write-Output "long step ${String(index + 1)}"`,
).join('\n')
const LONG_META = {
  v: 1,
  instrumented: true,
  refused: false,
  partial: false,
  preamble: '',
  steps: Array.from({ length: 30 }, (_, index) => ({
    line: index + 1,
    text: `Write-Output "long step ${String(index + 1)}"`,
    output: `long step ${String(index + 1)}`,
    startedAt: index * 100,
    endedAt: index * 100 + 80,
  })),
}

/**
 * The command the LIVE card reports, and the call id its record is written under.
 *
 * Four top-level steps, each ONE statement so that one line is one step (`& { … }` is
 * a script-block invocation, where `a; b` would be two statements and therefore two
 * steps).
 *
 * EVERY STEP IS REAL WORK. The figure is meant to look like a command somebody would
 * actually run, so the four lines print a timestamp, count processes, count the files in the
 * PowerShell install, and run a bounded computation — no `Start-Sleep` padding anywhere.
 * Every one of them prints ONE value: a `Measure-Object -Property … -Sum` table was here
 * first and it drew three blank rows in the picture, which read as broken rather than as
 * output. The computation is also what keeps the card IN FLIGHT while the shutter opens,
 * long enough that the picture shows a step with a ticking clock whatever the spec's own
 * timing turns out to be. Nothing here reads the network or the session's working
 * directory, so the figure depends on neither.
 */
const LIVE_CALL = 'call-live-1'
const LIVE_COMMAND = [
  "(Get-Date).ToString('MM-dd HH:mm:ss')",
  '(Get-Process | Measure-Object).Count',
  '(Get-ChildItem -Path $PSHOME -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count',
  '1..3000000 | ForEach-Object { $_ * 2 } | Measure-Object -Sum',
].join('\n')

/**
 * A single-LINE command: exactly one step, and NOT instrumented at all — there is no
 * order to keep, so no marker is written. That is the case the bar used to hide
 * completely (`barShape` said "no bar" for one step), and the reason the host now
 * stamps the step a one-step run begins with (`StepTracker.beginSoleStep`): its one
 * segment gets a real start and end instead of reading "pending" forever.
 */
const SOLE_CALL = 'call-live-sole-1'
/**
 * Forty-five seconds, not twenty: the suite now shoots TWO figures (each with its own boot and
 * hover) between the start of this run and the check that reads its one segment in flight, and
 * a run that ends first reads as "never running" rather than as a failure of the card.
 */
const SOLE_COMMAND = "& { Start-Sleep -Seconds 45; Write-Output 'one line' }"

/** The same four-step command under a second call id, so one card can be English-named. */
const LIVE_CALL_ZH = 'call-live-zh-1'

/**
 * A step whose output OVERFLOWS the per-step budget (`maxStepOutputChars`, 8192 by
 * default). The host drops whole lines past it and counts what it dropped; this is the
 * card that has to say so, and nothing else in the fixture can produce that state.
 */
const TRUNCATED_CALL = 'call-live-truncated-1'
const TRUNCATED_COMMAND = [
  // TWO lines, deliberately: a single-line command is never instrumented, and its output
  // is attributed to the PREAMBLE rather than to a step — which has no budget at all, so
  // it would never truncate anything. The budget is per STEP, so this needs a step.
  "& { 1..1200 | ForEach-Object { Write-Output ('line ' + $_ + ' padding padding padding') } }",
  "Write-Output 'done'",
].join('\n')

/**
 * A command the host REFUSES to instrument: PowerShell's own planner reports a syntax error,
 * so nothing is marked and the command runs exactly as written. Every line it prints — here,
 * PowerShell's own parse error — therefore arrives as the preamble, and the card draws the
 * command and that output with no bar and no step rows.
 *
 * THE SECOND LINE IS THE SUBJECT: `"$v: x"` is a variable reference PowerShell cannot parse,
 * which is exactly what makes the planner refuse.
 */
const REFUSED_CALL = 'call-live-refused-1'
const REFUSED_COMMAND = [
  'Write-Output "alpha"',
  '"$v: beta"',
].join('\n')

/** Every live run this fixture keeps in flight, and the call id each one answers. */
const LIVE_RUNS = [
  { callId: LIVE_CALL, command: LIVE_COMMAND, description: 'four-step environment check' },
  { callId: SOLE_CALL, command: SOLE_COMMAND, description: 'one-line command' },
  // The README's CHINESE figure. The card's title is the SHELL's own text — it follows
  // the language the host/browser resolves — while the summary after the separator is
  // this fixture's argument, so that half has to be published per language to match.
  { callId: LIVE_CALL_ZH, command: LIVE_COMMAND, description: '四步环境体检' },
  // And the one whose output the budget truncates, for the count the card has to state.
  { callId: TRUNCATED_CALL, command: TRUNCATED_COMMAND, description: '输出很长的步骤' },
  // And the refused one: ONE step carrying the whole command, plus the `!` that says it was
  // never split.
  { callId: REFUSED_CALL, command: REFUSED_COMMAND, description: 'refused command' },
]

/** One process-wide flag: `apply` can run again on a reload, the runs must not. */
let started = false

/**
 * Drive the REAL tool once per live call id, and leave every run in flight.
 *
 * The live arm of a card is fed by the plugin's own snapshot channel, which only has
 * something to answer while the tool is actually executing — a fabricated record
 * cannot show it. So this calls the registered tool definition directly
 * (`tools.get(...).execute(...)`, the entry point a model call reaches through the
 * executor) with the call id the session block below names.
 *
 * ONCE per call, and deliberately: the client's poll STOPS as soon as one answer says the
 * call is no longer running (`src/client/store.ts`: `if (!next.running) stop(callId)`), so
 * a second run under the same call id would never be seen. Both commands are therefore
 * long enough to still be in flight while the spec looks, and the host's own teardown
 * kills the shells it started (`stopHost` kills the tree it spawned).
 *
 * The registry is POLLED, not read once: this overlay is applied last among the
 * profile's patch rows, but the plugin that registers the tool is mounted by the
 * profile itself, and which of the two goes first is the profile's business rather
 * than this file's. Reading once found no tool and the card stayed empty.
 * @param ctx - the host context.
 */
function startLiveRuns(ctx) {
  if (started) return
  started = true
  const log = (message) => process.stdout.write(`SHELL_PROGRESS_E2E_LIVE ${message}\n`)
  const controller = new AbortController()
  const start = async () => {
    let tool
    for (let attempt = 0; attempt < 150 && tool === undefined; attempt += 1) {
      tool = ctx.get('tools')?.get('shell_progress_pwsh')
      if (tool === undefined) await new Promise((resolve) => { setTimeout(resolve, 200) })
    }
    if (tool === undefined) {
      log(`the shell_progress_pwsh tool never appeared — no live card; tools service is ${String(ctx.get('tools'))}`)
      return
    }
    log('driving the real tool for the live cards')
    for (const run of LIVE_RUNS) {
      // Each run is awaited on its own and started together: one finishing must not
      // delay the other, and both must still be in flight when the spec looks.
      void (async () => {
        try {
          await tool.execute(
            { command: run.command, description: run.description },
            { callId: run.callId, signal: controller.signal },
          )
          log(`${run.callId} finished`)
        } catch (error) {
          log(`${run.callId} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    }
  }
  void start()
}

/**
 * Publish the fixture session.
 *
 * Event order matters twice over: a step cannot start before a turn, and
 * `turn/start` is the one thing that clears the session list's `blank` flag —
 * which the client's `restoreSelection` requires before it will open a saved
 * session instead of creating a fresh blank one.
 * @param ctx - the host context.
 */
export function apply(ctx) {
  if (ctx.sessions.get(SESSION_ID) !== undefined) return // idempotent across a re-apply
  const session = ctx.sessions.create(SESSION_ID, { meta: { cwd: CWD } })

  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })

  // A `user/message` and a tool/result are surface events: the runtime REQUIRES
  // the append marker on those, and REJECTS it on `tool/call`.
  session.append('user/message', {
    id: 'msg-user-1',
    role: 'user',
    content: [{ type: 'text', text: 'run the four-step command' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })

  // A baseline `pwsh` call, so the transcript holds the native card the plugin's
  // card should sit beside — the whole point of this fixture.
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-pwsh-1',
    name: 'pwsh',
    arguments: JSON.stringify({ command: 'Write-Output hello', description: '基准：原版 pwsh 卡片' }),
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: toolMessage('call-pwsh-1', 'hello'),
  }, { surfaceOp: 'append' })

  // The call under test.
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-progress-1',
    name: 'shell_progress_pwsh',
    arguments: JSON.stringify({ command: COMMAND, description: '四步构建演示' }),
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: toolMessage('call-progress-1', '[1/4] fetch\n[2/4] build\n[3/4] test\n[4/4] pack'),
    meta: PROGRESS_META,
  }, { surfaceOp: 'append' })

  // The over-long step list (see `LONG_CALL`): its card is taller than the box showing it, so
  // the scroll strip exists the moment it opens. It lives in the FIRST turn on purpose: that
  // turn is folded in the figure contexts, so a thirty-row card adds no height there and the
  // README's photographs keep the crop they had.
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: LONG_CALL,
    name: 'shell_progress_pwsh',
    arguments: JSON.stringify({ command: LONG_COMMAND, description: 'long list demo' }),
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: toolMessage(LONG_CALL, Array.from({ length: 30 }, (_, index) => `long step ${String(index + 1)}`).join('\n')),
    meta: LONG_META,
  }, { surfaceOp: 'append' })

  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  // A SECOND turn that is left OPEN, so one card is genuinely in flight: the live
  // path cannot be reached with a settled transcript, and the whole point of the
  // probe line is to read what the polling loop did. A `tool/call` with no result
  // whose turn never ends is the only honest way to say "still running" here.
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('tool/call', {
    turn: 2,
    step: 1,
    callId: 'call-running-1',
    name: 'shell_progress_pwsh',
    arguments: JSON.stringify({ command: COMMAND, description: '正在运行的卡片' }),
  })

  // And one whose live record EXISTS, because a real run is kept in flight under it
  // (see `startLiveRuns`). Same shape — a call with no result whose turn stays open —
  // so the card renders in the live arm; the difference is that the snapshot channel
  // has an answer, which is what a running command actually looks like.
  session.append('tool/call', {
    turn: 2,
    step: 1,
    callId: LIVE_CALL,
    name: 'shell_progress_pwsh',
    arguments: JSON.stringify({ command: LIVE_COMMAND, description: 'four-step environment check' }),
  })

  // The settled card the hover figure is shot from: in THIS open turn, so it stays on screen
  // in the figure's narrow context, where the first turn is folded away.
  session.append('tool/call', {
    turn: 2,
    step: 1,
    callId: FIGURE_CALL,
    name: 'shell_progress_pwsh',
    arguments: JSON.stringify({ command: COMMAND, description: FIGURE_DESCRIPTION }),
  })
  session.append('tool/result', {
    turn: 2,
    step: 1,
    message: toolMessage(FIGURE_CALL, '[1/4] fetch\n[2/4] build\n[3/4] test\n[4/4] pack'),
    meta: PROGRESS_META,
  }, { surfaceOp: 'append' })

  // ...and the single-LINE one, whose card is the case a one-step command used to get
  // a counter for and no bar at all.
  session.append('tool/call', {
    turn: 2,
    step: 1,
    callId: SOLE_CALL,
    name: 'shell_progress_pwsh',
    arguments: JSON.stringify({ command: SOLE_COMMAND, description: 'one-line command' }),
  })

  // ...and the same command again for the README's Chinese figure, whose summary line has
  // to be Chinese to match the shell's own Chinese title on that shot.
  session.append('tool/call', {
    turn: 2,
    step: 1,
    callId: LIVE_CALL_ZH,
    name: 'shell_progress_pwsh',
    arguments: JSON.stringify({ command: LIVE_COMMAND, description: '四步环境体检' }),
  })

  // ...and one whose step prints far past the per-step output budget, so the card has to
  // state what it is not showing.
  session.append('tool/call', {
    turn: 2,
    step: 1,
    callId: TRUNCATED_CALL,
    name: 'shell_progress_pwsh',
    arguments: JSON.stringify({ command: TRUNCATED_COMMAND, description: '输出很长的步骤' }),
  })

  // ...and one the host REFUSED to instrument: it is still ONE command, so its card draws one
  // segment and one row (the whole command) plus the `!` saying the command was not split.
  session.append('tool/call', {
    turn: 2,
    step: 1,
    callId: REFUSED_CALL,
    name: 'shell_progress_pwsh',
    arguments: JSON.stringify({ command: REFUSED_COMMAND, description: 'refused command' }),
  })

  // Started after the transcript is published. The spec waits for the shape it wants
  // (one step done, the next in flight), and the runs hold their shapes for twenty
  // seconds, so the order of the two is not a race.
  startLiveRuns(ctx)

  process.stdout.write(`${MARKER}${SESSION_ID}\n`)
  if (!existsSync(CWD)) process.stdout.write(`SHELL_PROGRESS_E2E_WARN cwd missing: ${CWD}\n`)
}

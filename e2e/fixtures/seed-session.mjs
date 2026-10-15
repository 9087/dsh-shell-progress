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

/** The persisted presentation metadata, in the shape the card reads. */
const PROGRESS_META = {
  v: 1,
  instrumented: true,
  partial: false,
  preamble: '',
  steps: [
    { line: 1, text: 'Write-Output "[1/4] fetch"', output: '[1/4] fetch', startedAt: 0, endedAt: 1_200 },
    { line: 2, text: 'Write-Output "[2/4] build"', output: '[2/4] build', startedAt: 1_200, endedAt: 6_400 },
    { line: 3, text: 'Write-Output "[3/4] test"', output: '[3/4] test', startedAt: 6_400, endedAt: 7_600 },
    { line: 4, text: 'Write-Output "[4/4] pack"', output: '[4/4] pack', startedAt: 7_600, endedAt: 8_000 },
  ],
}

/**
 * The command the LIVE card reports, and the call id its record is written under.
 *
 * Four top-level steps, each ONE statement so that one line is one step (`& { … }` is
 * a script-block invocation, where `a; b` would be two statements and therefore two
 * steps). The first step is short and the rest are long, so that for twenty seconds
 * the card holds the shape the README figure wants: step 1 finished, step 2 in flight,
 * the last two still to come — a partly filled bar with a ticking clock, whatever the
 * spec's own timing turns out to be.
 */
const LIVE_CALL = 'call-live-1'
const LIVE_COMMAND = [
  "& { Start-Sleep -Seconds 1; Write-Output '[1/4] fetch' }",
  "& { Start-Sleep -Seconds 20; Write-Output '[2/4] build' }",
  "& { Start-Sleep -Seconds 20; Write-Output '[3/4] test' }",
  "& { Start-Sleep -Seconds 20; Write-Output '[4/4] pack' }",
].join('\n')

/**
 * A single-LINE command: exactly one step, and NOT instrumented at all — there is no
 * order to keep, so no marker is written. That is the case the bar used to hide
 * completely (`barShape` said "no bar" for one step), and the reason the host now
 * stamps the step a one-step run begins with (`StepTracker.beginSoleStep`): its one
 * segment gets a real start and end instead of reading "pending" forever.
 */
const SOLE_CALL = 'call-live-sole-1'
const SOLE_COMMAND = "& { Start-Sleep -Seconds 20; Write-Output 'one line' }"

/** The same four-step command under a second call id, so one card can be English-named. */
const LIVE_CALL_ZH = 'call-live-zh-1'

/** Every live run this fixture keeps in flight, and the call id each one answers. */
const LIVE_RUNS = [
  { callId: LIVE_CALL, command: LIVE_COMMAND, description: 'four-step build demo' },
  { callId: SOLE_CALL, command: SOLE_COMMAND, description: 'one-line command' },
  // The README's CHINESE figure. The card's title is the SHELL's own text — it follows
  // the language the host/browser resolves — while the summary after the separator is
  // this fixture's argument, so that half has to be published per language to match.
  { callId: LIVE_CALL_ZH, command: LIVE_COMMAND, description: '四步构建演示' },
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
    arguments: JSON.stringify({ command: LIVE_COMMAND, description: 'four-step build demo' }),
  })

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
    arguments: JSON.stringify({ command: LIVE_COMMAND, description: '四步构建演示' }),
  })

  // Started after the transcript is published. The spec waits for the shape it wants
  // (one step done, the next in flight), and the runs hold their shapes for twenty
  // seconds, so the order of the two is not a race.
  startLiveRuns(ctx)

  process.stdout.write(`${MARKER}${SESSION_ID}\n`)
  if (!existsSync(CWD)) process.stdout.write(`SHELL_PROGRESS_E2E_WARN cwd missing: ${CWD}\n`)
}

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
export const inject = ['sessions']

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

  process.stdout.write(`${MARKER}${SESSION_ID}\n`)
  if (!existsSync(CWD)) process.stdout.write(`SHELL_PROGRESS_E2E_WARN cwd missing: ${CWD}\n`)
}

/**
 * Step progress for multi-step shell commands, host half.
 *
 * The plugin adds ONE model-facing tool, `shell_progress`, which:
 *
 * 1. splits the command into top-level steps (see `./split.ts`, refined by
 *    PowerShell's own parser where a dialect can offer one — see
 *    `./pwshtree.ts`),
 * 2. inlines a marker onto each step's own line (see `./instrument.ts` —
 *    read its header before touching the marker; making it a function call
 *    silently breaks `$?` for the instrumented command),
 * 3. runs the instrumented text through `ctx.shell` exactly as `tool-pwsh`
 *    runs a plain command,
 * 4. reads the process's incremental output while it runs, turning each
 *    marker into "the current step" (see `./run.ts`),
 * 5. returns the model-visibly IDENTICAL text the `pwsh` tool would have
 *    returned, with the step data riding `presentationMeta` instead.
 *
 * Step data reaches the browser two ways, because a plugin installed outside
 * the DSH tree cannot receive host events (the forwarded-event allowlist is a
 * static array in the DSH build). The settled state is persisted with the
 * tool result and replays from the session log; the LIVE position is polled
 * off {@link PROGRESS_CHANNEL}, an authenticated request/response channel
 * this plugin owns.
 *
 * Mount this row in a profile's `cordis.patch.yml`:
 *
 * ```yaml
 * - insert:
 *     - id: shell-progress
 *       name: 'dsh-shell-progress'
 * ```
 *
 * @module dsh-shell-progress
 */

import { isAbsolute, resolve as resolvePath } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { TOOL_ABORTED, defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { ESCALATION_TARGETS } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest } from '@deepseek-ai/dsh-shell'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// Type-only imports whose module augmentations put `ctx.shell` and
// `ctx.shellEnv` on the context; erased at runtime.
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell-env'
import { createNonce, looksInstrumented, stripMarkers } from './instrument.ts'
import { drain, follow } from './run.ts'
import { renderShellResult } from './render.ts'
import type { CanonicalRunResult } from './render.ts'
import type { SplitResult, Step } from './split.ts'
import { META_VERSION, PROGRESS_CHANNEL } from './types.ts'
import type { LiveSnapshot, ShellProgressMeta } from './types.ts'
import { bashDialect } from './bash.ts'
import { pwshDialect } from './pwsh.ts'
import type { ShellDialect } from './dialect.ts'
import { StepTracker } from './tracker.ts'
import { requestStepNotes } from './llm-notes.ts'
import type { LlmLike } from './llm-notes.ts'

/** Stable Cordis plugin name. */
export const name = 'shell-progress'

/**
 * The capability seams this plugin consumes. `connection` is optional in
 * practice: without it the bar still draws every step, it just cannot show
 * which one is running.
 */
export const inject: string[] = ['tools', 'shell', 'shellEnv', 'connection', 'webServer']

/**
 * The step-note preference, as the CLIENT last pushed it.
 *
 * Held in memory on purpose. It is a rendering preference of the GUI that shows the card,
 * not state of any run: the client knows the reader's language — it is the thing rendering
 * the notes — and it is the client that owns the switch, so it sends both on connect and
 * whenever the switch flips. No locale means NO request at all, because a note written in
 * the wrong language is worse than no note.
 */
const notesConfig: { enabled: boolean; locale: string | undefined } = { enabled: true, locale: undefined }

/**
 * Reasons the notes cannot be written that have already been reported.
 *
 * SILENCE HAS A COST THIS FEATURE ALREADY PAID. With no llm service, no route or no locale,
 * the note simply never appears — and nothing anywhere says which of the three it was, so
 * the only thing a reader can do is guess. Each reason is therefore stated ONCE per process:
 * visible enough to diagnose, quiet enough not to repeat on every command. `warn` and not
 * `debug`, for the same reason the refusal notice is a `warn`: it has to show up without
 * turning debug logging on.
 */
const notesDiagnosed = new Set<string>()

/**
 * Set the note preference pushed by the client.
 * @param options - the fields to change; absent fields keep their current value.
 */
export function setStepNotesOptions(options: { readonly enabled?: boolean; readonly locale?: string | undefined }): void {
  if (options.enabled !== undefined) notesConfig.enabled = options.enabled
  if ('locale' in options) {
    notesConfig.locale = typeof options.locale === 'string' && options.locale.length > 0 ? options.locale : undefined
  }
}

/**
 * The provider route this call's own session uses, taken from the agent the executor hands
 * every tool run.
 *
 * Widened structurally, exactly as `exec.agent.session` is read above: this module must not
 * depend on the agent package for one property. Absent or malformed route means no request.
 * @param exec - the tool run context.
 * @returns the route, or undefined when the host did not provide one.
 */
function notesRoute(exec: { readonly agent?: unknown }): { readonly provider: string; readonly model: string } | undefined {
  const options = (exec.agent as { readonly options?: { readonly provider?: unknown; readonly model?: unknown } } | undefined)?.options
  const provider = options?.provider
  const model = options?.model
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/** Configuration for the step-progress tool. */
export interface Config {
  /** Register the `shell_progress` tool (default true). */
  enabled?: boolean
  /** Milliseconds between output reads while a command runs (default 120). */
  pollIntervalMs?: number
  /** Per-step output kept in the persisted progress, in characters (default 8192). */
  maxStepOutputChars?: number
  /** Commands split into more steps than this run unmodified (default 400). */
  maxSteps?: number
  /** How long a settled call's live record is kept for a late poll, ms (default 300000). */
  liveRetentionMs?: number
  /**
   * Which dialects this host exposes a tool for.
   *
   * A tool cannot discover its dialect — `ctx.shell` carries no dialect tag — and
   * BOTH tools ride that same seam. On a host whose executor speaks PowerShell, a
   * bash tool would hand bash syntax to PowerShell, so the mounted executor decides,
   * and only the PROFILE knows which one that is. Defaults to `['pwsh']`, the
   * Windows default; a POSIX host sets `['bash']`.
   */
  dialects?: string[]
}

/** Runtime configuration schema for the step-progress tool plugin. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  pollIntervalMs: z.number().default(120),
  maxStepOutputChars: z.number().default(8192),
  maxSteps: z.number().default(400),
  liveRetentionMs: z.number().default(300_000),
  dialects: z.array(z.string()).default(['pwsh']),
})

/** One live call's record, answered by the channel's `snapshot` endpoint. */
interface LiveEntry {
  tracker: StepTracker
  readonly steps: readonly Step[]
  readonly instrumented: boolean
  /** Whether instrumentation was refused; the client's "ran unmodified" signal. */
  readonly refused: boolean
  /** Wall-clock ms the record was created, used only for eviction. */
  readonly createdAt: number
  settled: boolean
  lossy: boolean
}

/** The slice of the Host connection service this plugin mounts its channel with. */
interface ConnectionServiceSurface {
  readonly rpc: {
    handle: (
      channel: string,
      handler: ChannelHandler,
      options?: { readonly authority: 'trusted-host' | 'loopback' },
    ) => () => unknown
  }
  /**
   * Channel registration that names the CALLER's context as the owner. This is
   * the documented intent ("channel registrations belong to the caller
   * fiber") and it is what `dsh-diff-approval` prefers too, because the
   * published `rpc.handle` hardcodes the service's own context and can throw
   * `cannot get property "webServer" without inject` there. The published
   * types mark this private, hence the local declaration.
   */
  register?: (
    ctx: Context,
    channel: string,
    handler: ChannelHandler,
    options?: { readonly authority: 'trusted-host' | 'loopback' },
  ) => () => unknown
}

/** One decoded channel endpoint call. */
type ChannelHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer: unknown,
) => Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }>

/** The host-side sandbox policy service, consumed opportunistically. */
interface SandboxPolicyService {
  resolve(input: { session?: unknown }): SandboxExecutionPolicy | undefined
}

/** The slice of the system-prompt service this plugin contributes to. */
interface PromptService {
  section(section: { readonly name: string; readonly order: number; readonly text: string }): () => void
  getSectionOrder(name: 'TOOL_PWSH'): number
}

/** A channel failure in the closed RPC error vocabulary. */
function rpcError(message: string): { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } } {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/** The structured abort the foreground path throws when the caller cancels. */
function toolAborted(): Error {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

/** Render a thrown value without ever throwing. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve an explicit workdir first, making a relative one session-workspace-relative. */
function resolveWorkdir(modelWorkdir: string | undefined, exec: ToolRunContext): string | undefined {
  // `exec.agent` is structurally widened here so this module does not depend on
  // the session package's types for one property read.
  const agent = exec.agent as { session?: { header?: { cwd?: string } } } | undefined
  const headerCwd = agent?.session?.header?.cwd
  if (modelWorkdir === undefined) return headerCwd
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) return resolvePath(headerCwd, modelWorkdir)
  return modelWorkdir
}

/** The output schema: the `pwsh` tool's canonical shape plus this tool's progress. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'foreground' },
    exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
    signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    timedOut: { type: 'boolean', required: true },
    aborted: { type: 'boolean', required: true },
    timeoutMs: { type: 'number', required: true },
    stdout: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        text: { type: 'string', required: true },
        truncated: { type: 'boolean', required: true },
        spillPath: { type: 'string' },
      },
    },
    stderr: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        text: { type: 'string', required: true },
        truncated: { type: 'boolean', required: true },
        spillPath: { type: 'string' },
      },
    },
    sandbox: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', required: true, enum: ['read-only', 'workspace-write', 'danger-full-access'] },
        denied: { type: 'boolean', required: true },
        enforcement: { type: 'string' },
        runnerFailed: { type: 'boolean' },
      },
    },
    progress: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        v: { type: 'integer', required: true },
        instrumented: { type: 'boolean', required: true },
        refused: { type: 'boolean', required: true },
        partial: { type: 'boolean', required: true },
        preamble: { type: 'string', required: true },
        steps: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              line: { type: 'integer', required: true },
              text: { type: 'string', required: true },
              output: { type: 'string', required: true },
              // NOT required: a record persisted before this field existed still
              // validates, and the client reads a missing value as zero.
              droppedChars: { type: 'integer' },
              // NOT required, and absent is the NORM: a step carries a note only when the
              // model answered about it (see `src/llm-notes.ts`). A record written without
              // one — or with the feature switched off — must still validate.
              note: { type: 'string' },
              startedAt: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              endedAt: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
        },
      },
    },
  },
} as const

/**
 * Whether this command may be instrumented at all, and why not when it may not.
 * Every refusal falls back to running the command exactly as written.
 * @param dialect - the shell this tool drives; its reserved variable is the one
 * dialect-specific refusal in this list.
 * @param command - the model's command text.
 * @param split - the resolved split. Its `safe` flag decides, and its OWN reason
 * is the honest one when it has one: for a dialect with a planner that says
 * whether the parse was unavailable or reported syntax errors, which the generic
 * sentence below would hide.
 * @param readOnly - whether the resolved sandbox mode refuses writes.
 * @param maxSteps - the configured step ceiling.
 * @returns undefined when instrumentation is allowed, else the reason.
 */
function refusalReason(
  dialect: ShellDialect,
  command: string,
  split: SplitResult,
  readOnly: boolean,
  maxSteps: number,
): string | undefined {
  if (!split.safe) return split.reason ?? 'the command holds a structure this plugin cannot split safely'
  const steps = split.steps
  if (steps.length <= 1) return 'a single-line command has no steps to show'
  if (steps.length > maxSteps) return `the command has more than ${maxSteps} steps`
  if (looksInstrumented(command)) return 'the command already contains a step-marker shape'
  const reserved = dialect.reservedVariable
  if (reserved !== undefined && command.includes(reserved)) return `the command already uses ${reserved}`
  if (readOnly) return 'the sandbox mode is read-only'
  return undefined
}

/**
 * The split to instrument with: the dialect's authoritative plan when it has
 * one, else its own heuristic — and NEVER the heuristic for a dialect that has
 * a planner.
 *
 * A dialect that ships a planner has handed "what is a top-level statement?" to
 * that dialect's real parser, so when the planner cannot deliver a parse there is
 * no answer left to fall back on. The heuristic is a DIFFERENT implementation of
 * the same question, and two independent implementations cannot be shown to
 * agree: an unconfirmed boundary is exactly the guess that can land a marker
 * inside a block and corrupt the command. Refusing is the safe degradation — the
 * command runs unmodified, which is always correct, merely less observable.
 *
 * A command with at most one safe step is not a refusal: there is no boundary to
 * decide, so it is simply uninstrumented (and a planning probe would only buy a
 * process spawn). That is what keeps the card's "ran unmodified" notice off an
 * ordinary single-line command, and it is why the refusal result — whose step
 * list is EMPTY — needs its own signal rather than a step count.
 * @param dialect - the shell this tool drives.
 * @param command - the model's command text.
 * @returns the steps to instrument with, and whether instrumentation may proceed.
 */
async function resolveSplit(dialect: ShellDialect, command: string): Promise<SplitResult> {
  const heuristic = dialect.split(command)
  if (dialect.plan === undefined) return heuristic
  if (heuristic.safe && heuristic.steps.length <= 1) return heuristic
  let planned: SplitResult | undefined
  try {
    planned = await dialect.plan(command)
  } catch {
    // A probe that throws has no answer either: the refusal below covers it, so
    // a planner's own failure can never turn into an instrumentation guess.
    planned = undefined
  }
  if (planned !== undefined) return planned
  return {
    steps: [],
    safe: false,
    reason: `the ${dialect.id} parser did not answer, so the step boundaries are unknown`,
  }
}

/**
 * The shells this plugin drives, one tool each.
 *
 * A tool cannot DISCOVER its dialect: the executor seam carries no dialect tag
 * (see `./dialect.ts`), so each tool declares one statically — which is also how
 * DSH itself pairs `dsh-tool-pwsh` and `dsh-tool-bash` with one seam.
 */
const DIALECTS: readonly ShellDialect[] = [pwshDialect, bashDialect]

/** Register the tool and the live-progress channel. */
export function apply(ctx: Context, config: Config = {}): void {
  const enabled = config.enabled ?? true
  // Only the dialects this profile asked for. Registering both unconditionally
  // would hand the model a bash tool whose commands go to a PowerShell executor.
  const wanted = config.dialects ?? ['pwsh']
  const dialects = DIALECTS.filter((entry) => wanted.includes(entry.id))
  const pollIntervalMs = config.pollIntervalMs ?? 120
  const maxStepOutputChars = config.maxStepOutputChars ?? 8192
  const maxSteps = config.maxSteps ?? 400
  const liveRetentionMs = config.liveRetentionMs ?? 300_000

  const defaultMode = ctx.shell.sandboxMode
  const escalationModes: readonly SandboxMode[] = defaultMode === undefined ? [] : ESCALATION_TARGETS
  const sandboxPolicy = ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error('shell-progress: the mounted shell executor confines but ctx.sandboxPolicy is missing')
  }

  /** The live records of this plugin instance, keyed by call id. */
  const live = new Map<string, LiveEntry>()

  /** Drop records nothing will ask about again. */
  const prune = (now: number): void => {
    for (const [callId, entry] of live) {
      if (entry.settled && now - entry.createdAt > liveRetentionMs) live.delete(callId)
    }
  }

  /** Answer one snapshot question, for a call this host may or may not hold. */
  const snapshotFor = (callId: string): LiveSnapshot => {
    prune(Date.now())
    const entry = live.get(callId)
    if (entry === undefined) {
      return {
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
      }
    }
    return {
      found: true,
      running: !entry.settled,
      instrumented: entry.instrumented,
      refused: entry.refused,
      partial: entry.lossy || entry.tracker.droppedOutput(),
      current: entry.tracker.current(),
      total: entry.steps.length,
      elapsedMs: entry.tracker.elapsed(performance.now()),
      preamble: entry.tracker.preamble(),
      steps: entry.tracker.steps(),
    }
  }

  const handle: ChannelHandler = async (endpoint, payload) => {
    try {
      // The client's note preference. Not a snapshot verb: it carries no call id and
      // answers with the setting the host is now using, so a client can confirm what took.
      if (endpoint === 'configure') {
        const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
          ? payload as { readonly enabled?: unknown; readonly locale?: unknown }
          : {}
        setStepNotesOptions({
          ...typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {},
          ...typeof record.locale === 'string' ? { locale: record.locale } : {},
        })
        return { ok: true, value: { enabled: notesConfig.enabled, locale: notesConfig.locale ?? null } }
      }
      if (endpoint !== 'snapshot') return rpcError(`unknown endpoint ${JSON.stringify(endpoint)}`)
      const callId = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as { readonly callId?: unknown }).callId
        : undefined
      if (typeof callId !== 'string' || callId.length === 0) return rpcError('snapshot needs a non-empty callId')
      return { ok: true, value: snapshotFor(callId) }
    } catch (error) {
      return rpcError(errorMessage(error))
    }
  }

  if (enabled) {
    for (const dialect of dialects) ctx.tools.register(defineTool({
      name: dialect.toolName,
      // A single shared literal used to be registered for both dialects, so bash advertised itself as
      // PowerShell and a correction could only be made in one of the two places; `commandParamDescription`
      // below is per-dialect for the same reason.
      description: dialect.description,
      parameters: {
        command: {
          type: 'string',
          required: true,
          description: dialect.commandParamDescription,
        },
        description: {
          type: 'string',
          required: true,
          description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
        },
        workdir: {
          type: 'string',
          description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
        },
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: renderShellResult(value as unknown as CanonicalRunResult, escalationModes),
        }],
        // The whole point of declaring this: it is persisted verbatim on
        // `tool/result`, so a reloaded session rebuilds the card from the log.
        presentationMeta: (_args, value) => value.progress as unknown as JsonValue,
      },
      async execute(args, exec) {
        if (args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
        if (args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
        if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
          throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
        }

        const standing = exec.agent === undefined ? {} : { session: exec.agent.session }
        const policy = sandboxPolicy?.resolve(standing)
        const readOnly = policy?.mode === 'read-only'
        const split = await resolveSplit(dialect, args.command)
        const reason = refusalReason(dialect, args.command, split, readOnly, maxSteps)
        const instrumented = reason === undefined
        // The client's explicit REFUSAL signal. A step count cannot carry it: a
        // refusal is not a guess, so it plans NO steps, and a zero-step refused
        // card would otherwise look exactly like a command with nothing to show
        // and lose its notice. The one uninstrumented case that is not a refusal
        // is "there was no boundary to decide" (a single safe step), which is
        // what keeps the card quiet for an ordinary single-line command.
        const refused = reason !== undefined && !(split.safe && split.steps.length <= 1)
        // A REFUSAL REPORTS NO STEPS. The planner hands back a best-effort list even when it
        // reports a syntax error, and rendering that list was a lie: the command ran WITHOUT
        // markers, so those rows could only ever read "pending" — no timing, no output of
        // their own — while everything the command actually printed sat in the preamble under
        // a label about a "first step" that never existed. `refused` is the answer; the steps
        // are the guess it declined to trust. Reporting none also makes the client's own
        // assumption true again (see `model.ts`: an empty list plus the flag IS the refusal).
        const steps = refused ? [] : split.steps
        // `warn`, not `debug`: the card no longer says anything about tracking — a refused
        // call shows its command and its output, nothing more — so this line is the only
        // place the REASON is stated, and it has to be visible without debug logging on.
        if (reason !== undefined) ctx.logger.warn(`shell-progress: running the command unmodified — ${reason}`)

        const nonce = createNonce()
        const text = instrumented ? dialect.instrument(args.command, split.steps, nonce) : args.command
        const workdir = resolveWorkdir(args.workdir, exec)
        const request: ShellExecRequest = {
          command: text,
          ...workdir === undefined ? {} : { workdir },
          ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
          dshEnv: ctx.shellEnv.collect(exec),
          ...policy === undefined ? {} : { sandboxPolicy: policy },
          signal: exec.signal,
        }

        const created = Date.now()
        const entry: LiveEntry = {
          tracker: new StepTracker(steps, { maxStepOutputChars }),
          steps,
          instrumented,
          refused,
          createdAt: created,
          settled: false,
          lossy: false,
        }
        live.set(exec.callId, entry)
        prune(created)

        // A single-line command is NOT instrumented — there is no order to keep, so no
        // marker is ever written — and nothing else would give its one step a start
        // time. Without this the card had no segment to draw (`barShape` suppressed a
        // one-step bar) and nothing to colour if it had: the step could only read
        // "pending" and the counter `0/1` even after the command finished.
        if (!instrumented && steps.length === 1) entry.tracker.beginSoleStep()

        // ONE LINE PER STEP, WRITTEN BY THE MODEL, in the reader's own language.
        //
        // Deliberately NOT awaited before the run starts: a command must never wait for its
        // own description. The request goes out beside the command, and the answer is
        // attached to the tracker when it lands, so the client's next snapshot poll carries
        // it. Cancellation rides on `exec.signal`, so a run that ends takes its request with
        // it — and every failure is silent by construction (`requestStepNotes` answers
        // undefined), which is what keeps a convenience out of the card's correctness.
        if (notesConfig.enabled && steps.length > 0) {
          const route = notesRoute(exec)
          const locale = notesConfig.locale
          const llm = ctx.get('llm') as LlmLike | undefined
          // One complaint per gate, and the FIRST one is the first thing to fix: the chain is
          // walked in the order the request needs it. A host that cannot write notes says so
          // rather than looking like a feature that does not work.
          const complain = (reason: string): void => {
            if (notesDiagnosed.has(reason)) return
            notesDiagnosed.add(reason)
            ctx.logger.warn(`shell-progress: no step notes — ${reason}`)
          }
          if (locale === undefined) complain('the client has not said which language to write them in')
          else if (route === undefined) complain('the agent carries no provider/model route')
          else if (llm === undefined) complain('this host has no llm service')
          else {
            const notes = requestStepNotes({
              llm,
              provider: route.provider,
              model: route.model,
              locale,
              lines: steps.map((step) => step.text),
              signal: exec.signal,
            })
            void notes.then((answer) => {
              if (answer === undefined) {
                complain('the model call produced no notes: a refusal, a timeout or an empty answer')
                return
              }
              entry.tracker.setNotes(answer)
            })
          }
        }

        let execution
        try {
          execution = await ctx.shell.execute(ctx.shell.resolve(request))
        } catch (error) {
          entry.settled = true
          throw error
        }

        let lossy = false
        try {
          if (instrumented) {
            const followed = await follow(execution, {
              steps: split.steps,
              nonce,
              pollIntervalMs,
              maxStepOutputChars,
              // The SAME tracker the live channel reads. Without this, `follow`
              // drove a tracker of its own and only handed it over once the
              // command had ENDED, so the channel answered `found: true` with an
              // empty tracker for the whole run (`current: -1`, `elapsedMs: 0`)
              // and the bar could only move at the end.
              tracker: entry.tracker,
            })
            lossy = followed.lossy
            entry.tracker = followed.tracker
          } else {
            await drain(execution)
            entry.tracker.settle()
          }
        } finally {
          entry.settled = true
          entry.lossy = lossy
        }

        const result = await execution.result()
        if (result.aborted) throw toolAborted()

        // A refused run's card is the PLAIN one: the command, then everything it produced.
        // What it can draw comes from the tracker, and the tracker only ever saw STDOUT —
        // while the commonest refusal of all, a syntax error, prints its message on STDERR
        // and nothing on stdout. Without this, exactly the case the plain card exists for
        // would render an empty body. The model's own view is untouched: `result` is returned
        // below as it always was, and this feeds the CARD.
        if (refused && result.stderr.text.length > 0) {
          entry.tracker.observe({ kind: 'text', text: result.stderr.text })
        }

        const progress: ShellProgressMeta = {
          v: META_VERSION,
          instrumented,
          refused,
          partial: lossy || entry.tracker.droppedOutput(),
          preamble: entry.tracker.preamble(),
          // The canonical value is validated against the output schema, which
          // declares a plain array — hence the copy out of the tracker's
          // readonly view.
          steps: [...entry.tracker.steps()],
        }

        return {
          kind: 'foreground' as const,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          aborted: result.aborted,
          timeoutMs: result.timeoutMs,
          stdout: {
            // The model must never see a marker, so the full captured stream is
            // stripped here rather than the delta the poll loop consumed.
            text: instrumented ? stripMarkers(result.stdout.text, nonce) : result.stdout.text,
            truncated: result.stdout.truncated,
            ...result.stdout.spillPath === undefined ? {} : { spillPath: result.stdout.spillPath },
          },
          stderr: {
            text: result.stderr.text,
            truncated: result.stderr.truncated,
            ...result.stderr.spillPath === undefined ? {} : { spillPath: result.stderr.spillPath },
          },
          ...result.sandbox === undefined ? {} : {
            sandbox: {
              mode: result.sandbox.mode,
              denied: result.sandbox.denied,
              ...result.sandbox.enforcement === undefined ? {} : { enforcement: result.sandbox.enforcement },
              ...result.sandbox.runnerFailed === undefined ? {} : { runnerFailed: result.sandbox.runnerFailed },
            },
          },
          progress,
        }
      },
      presentCall: (args) => ({
        card: 'terminal',
        title: args.command,
        description: args.description,
        ...args.workdir === undefined ? {} : { cwd: args.workdir },
      }),
    }))
  }

  // The model can see both `pwsh` and `shell_progress`, and left to itself it
  // reaches for the tool it already knows. This is the same mechanism
  // `tool-pwsh` uses for its own guidance, placed in the shell-tool slot
  // (`TOOL_PWSH`). It is OPTIONAL: a deployment whose prompt service is absent,
  // or arrives later, still gets the tool and the card — just no nudge.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const prompt = (promptCtx as unknown as { systemPrompt: PromptService | undefined }).systemPrompt
    if (prompt === undefined) return
    prompt.section({
      name: 'tool:shell-progress',
      order: prompt.getSectionOrder('TOOL_PWSH'),
      text: dialects.map((entry) => entry.guidance).join(' '),
    })
  })

  // Mount the live-progress channel. Without `connection` the bar still draws
  // the steps; only the live position is lost, so this degrades rather than throws.
  ctx.effect(() => {
    // `connection` IS injected (see this plugin's `inject`), which is what makes
    // this registration legal: an earlier version left it out of `inject` and only
    // read the service, so the channel was registered by a context with NO
    // dependency on the transport and the host refused every request on it. The
    // card still drew its planned steps, so the symptom was exactly "the bar never
    // moves". `dsh-diff-approval`, which works on this host, declares the inject
    // and reads the property. THIS half goes through `ctx.get` instead, because
    // that is the TOLERANT read: on a host with no connection service the plugin
    // still activates and still registers the tool, losing only the live channel.
    // Switching to the property read needs the connection package's `Context`
    // augmentation (a type-only import of `@deepseek-ai/dsh-client-connection`),
    // and it makes the service a hard requirement — `tests/apply.spec.ts` pins the
    // graceful-degradation path, so that switch is a change of its own.
    const service = ctx.get('connection') as ConnectionServiceSurface | undefined
    if (service === undefined) {
      ctx.logger.debug('shell-progress: no connection service, so live step position is unavailable')
      return () => {}
    }
    const options = { authority: 'trusted-host' as const }
    if (typeof service.register === 'function') return service.register(ctx, PROGRESS_CHANNEL, handle, options)
    return service.rpc.handle(PROGRESS_CHANNEL, handle, options)
  }, 'shell-progress: progress channel')
}

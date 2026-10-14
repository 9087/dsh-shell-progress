# dsh-shell-progress

A DeepSeek Harness plugin that shows **where a multi-step shell command is right
now**, as a segmented progress bar inside the tool-call card.

One call, one card:

```
┌──────────────────────────────────────────────────┐
│ Shell progress · 构建并运行测试          2/7     │
│ [████|████|▓▓▓|    |    |    |    ]  ▶ 47s      │   ← 收起态就有
├──────────────────────────────────────────────────┤
│  ● 1   $total = 0                                │
│  ● 2   if ($true) {                              │   ← 展开后：
│  ▶ 3     Write-Output "adding $n"                │      每步代码 + 该步输出
│        → adding 1                                │
│  ○ 4   Write-Output "done"                       │
└──────────────────────────────────────────────────┘
```

The question it answers is *"is this command still working, or is it stuck?"* —
so the live position is the feature, not a bonus. The bar lives in the
**collapsed** card: a glance at the transcript is the whole point, and hiding it
behind a disclosure would make it a two-step interaction.

## Install

```sh
dsh plugin --profile web add dsh-shell-progress
```

Or mount it by hand in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: shell-progress
      name: dsh-shell-progress
```

Then restart `dsh web` (the host loads the plugin once, at start-up).

## What the model sees

Nothing new. `shell_progress` registers a tool whose model-visible text is
**byte-identical** to what the `pwsh` tool returns for the same command — same
stdout, same `[stderr]` section, same `[exit code: N]` markers. Step data never
enters the conversation; it travels in the tool result's `presentationMeta`,
which the harness persists on the `tool/result` event.

There is no nonce, no marker and no reordering anywhere the model can read.

## Configuration

```yaml
- insert:
    - id: shell-progress
      name: dsh-shell-progress
      config:
        enabled: true
        pollIntervalMs: 120
        maxStepOutputChars: 8192
        maxSteps: 400
        liveRetentionMs: 300000
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Register the `shell_progress` tool. |
| `pollIntervalMs` | `120` | How often the host reads the running process's output. |
| `maxStepOutputChars` | `8192` | Per-step output kept in the persisted progress. |
| `maxSteps` | `400` | A command split into more steps than this runs unmodified. |
| `liveRetentionMs` | `300000` | How long a settled call's live record is kept for a late poll. |

## How it works

1. **Split.** The command is cut into *top-level steps*: non-empty lines that
   start at column 0, do not start with `}`, and sit at brace depth 0. Brace
   counting skips single-quoted strings, double-quoted strings (with the
   backtick escape) and `#` comments. Loop bodies are never steps, so one
   iteration cannot produce a marker.
2. **Instrument.** Each step's own line gets an inlined marker prefixed to it —
   never a new line, so the line count and every other line stay untouched.
3. **Run.** The instrumented text goes through `ctx.shell`, exactly as the
   `pwsh` tool runs a command, with the same timeout, sandbox policy, managed
   environment and cancellation.
4. **Follow.** While the process runs, the host reads its incremental output and
   turns each marker into "the current step", stamping a monotonic timestamp.
5. **Persist.** The final per-step timings and output ride
   `output.presentationMeta`, so a reloaded session rebuilds the whole card from
   the session log alone.

### The marker must stay inlined

`src/instrument.ts` carries the long version; the short one is that a PowerShell
function call is itself a command, and running it overwrites `$?`. A marker
written as a helper therefore clobbers the automatic variable it was asked to
preserve — and the caller's `$?` afterwards reports the *helper's* success, so
even a helper that captures and restores the value internally cannot fix it.
Measured on this host (Windows PowerShell 5.1, which is what the shell seam
resolves to when PowerShell 7 is not installed):

| Marker shape | `$?` after a failed command |
|---|---|
| none (control) | `False` ✅ |
| helper function, capture + restore inside | `True` ❌ |
| **inlined capture + restore** | `False` ✅ |

`tests/powershell.spec.ts` runs both shapes against a real shell and asserts the
difference, so a future refactor into a helper fails the suite.

## When it does not track

The command runs **unmodified**, and the card degrades to "how many steps"
without a live position, when any of these hold:

- the splitter meets something it cannot decide (unterminated quote, block
  comment, here-string, line continuation, unbalanced braces or parentheses);
- the command has one step or fewer;
- the command already contains a step-marker shape, or already uses `$__ok`;
- the resolved sandbox mode is `read-only`;
- the command splits into more than `maxSteps` steps.

None of these is an error: the model gets exactly what `pwsh` would have given.

## Layout

| Half | Source | Runs in |
|---|---|---|
| Host | `src/index.ts` (+ the pure modules beside it) | the DSH host process (Node) |
| Client | `src/client/*` (React) | the browser |

The two halves share `src/types.ts` and `src/split.ts` and nothing else.

**The live channel is a poll, not a push.** A plugin installed outside the DSH
tree cannot receive host events — the forwarded-event allowlist is a static
array inside the DSH build — so the browser polls `/shell-progress` (an
authenticated request/response channel this plugin owns) about half a second
apart while a call is in flight. The settled state never needs the poll: it is
already in the session log.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

See [DEVELOP.md](DEVELOP.md) and [PUBLISH.md](PUBLISH.md).

## License

MIT

# dsh-shell-progress

English | [中文](https://github.com/9087/dsh-shell-progress/blob/main/README.zh.md)

<!-- Badges. `ci.yml` and `harness-matrix.yml` both run on `main`, so their badges
     track it. `release.yml` is TAG-triggered and has no status on a branch — a
     branch badge for it renders "no status" — so its badge is pinned to a tag and
     `?branch=v0.4.2` below must be bumped with each release. -->
[![npm](https://img.shields.io/npm/v/dsh-shell-progress)](https://www.npmjs.com/package/dsh-shell-progress)
[![license](https://img.shields.io/npm/l/dsh-shell-progress)](https://github.com/9087/dsh-shell-progress/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.11-339933)](https://github.com/9087/dsh-shell-progress/blob/main/package.json)
[![ci](https://github.com/9087/dsh-shell-progress/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/9087/dsh-shell-progress/actions/workflows/ci.yml)
[![harness matrix](https://github.com/9087/dsh-shell-progress/actions/workflows/harness-matrix.yml/badge.svg?branch=main)](https://github.com/9087/dsh-shell-progress/actions/workflows/harness-matrix.yml)
[![release](https://github.com/9087/dsh-shell-progress/actions/workflows/release.yml/badge.svg?branch=v0.4.2)](https://github.com/9087/dsh-shell-progress/actions/workflows/release.yml)

A DeepSeek Harness plugin that shows **where a multi-step shell command is right
now**, as a segmented progress bar inside the tool-call card.

<!-- Absolute, not `docs/assets/running.png`: npmjs.com renders only the README it
     snapshotted at publish time and does not serve the repository tree, so a relative
     path shows a broken image there. The file still lives in the repo, and
     `pnpm run e2e` rewrites it, so this URL follows the code. -->
![The card while a four-step command runs: a partly filled segmented bar with the step in flight and its clock, the finished step's output beneath it, and the steps still to come](https://raw.githubusercontent.com/9087/dsh-shell-progress/main/docs/assets/running.png)

*The real card, expanded, with `3/4` done and step 4 in flight.*

## Features

Collapsed, the card's summary row carries a segmented bar, one segment per top-level step (pending, running or done), beside a `3/4` counter, so where the command is and how many steps are left read at a glance. Hover a segment and it opens that step's card, showing its command line, its output and its time.

![The card a segment opens on hover: that step's own command line, its output and its time](https://raw.githubusercontent.com/9087/dsh-shell-progress/main/docs/assets/hover.png)

In the hover card, each step gets a one-line comment above its command line, spelling out what that line is for. (The lines come from the model, which costs one extra call per command; they can be switched off on the DSH Settings page under "Shell Progress" and are on by default.)

Expanding the card shows the command's steps, one row each: the line's command, plus its time and output; the step in flight carries a running clock.

A command that cannot be split, or that the plugin declines to track, is still ONE command: the card draws one segment, and a `!` after the title explains on hover that the command was not split, so the bar describes the whole command rather than per-step progress. The command itself runs exactly as it does under the `pwsh` tool, and its output obeys the same per-step budget.

## Install

In DSH, open the **Plugins** page and click **Add plugin**, then enter `dsh-shell-progress` (the npm package name).

Or from the command line:

```sh
dsh plugin --profile web add dsh-shell-progress
```

Or mount it by hand in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: shell-progress
      name: dsh-shell-progress
```

Either way, restart `dsh web` afterwards (the host loads plugins once, at start-up).

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

When a step's output passes `maxStepOutputChars`, the lines that do not fit are dropped from
the CARD's copy, and that step's output is followed by the number of characters that are
missing (in the step list and in the segment's hover card alike). Without it a truncated
step reads exactly like a quiet one. The budget is the card's memory, not the tool result:
the model-visible stdout comes from the shell seam and is unaffected by it (the seam's own
`truncated` / `spillPath` reporting applies as it always does).

## Development

Development, testing and publishing details live in [DEVELOP.md](DEVELOP.md) and [PUBLISH.md](PUBLISH.md).

## License

MIT

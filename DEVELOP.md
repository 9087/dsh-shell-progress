# Develop

## Layout

| Half | Source | Built to | Runs in |
|---|---|---|---|
| Host | `src/*.ts` (`src/index.ts` is the entry) | `lib/index.js` | the DSH host process (Node, ESM) |
| Client | `src/client/*` (React, `src/client/index.ts`) | `lib/client.js` | the browser, inside the shell's pages |

`src/types.ts` and `src/split.ts` are shared by both halves and must stay free
of Node and DOM imports.

## Commands

```sh
pnpm install
pnpm run typecheck   # tsc over both faces
pnpm test            # vitest
pnpm run build       # emits lib/index.js and lib/client.js
```

The repo `.npmrc` pins the official registry, which is what publishing must use
— but on a machine whose default is a mirror, `registry.npmjs.org` can be slow
or throttled enough that installs fail. Use the mirror for local installs only:

```sh
pnpm install --registry=https://registry.npmmirror.com
```

The unit suite reads `src/` directly, so it needs no build. The client bundle
does: the shell serves the built `lib/client.js`, not the source.

**The client bundle is large on purpose.** Shiki's core and the two grammars the
step list highlights (`powershell`, `shellscript`) are INLINED: `noExternal` in
`build/tsdown.client.ts` bundles everything the loader module table cannot
answer, which takes `lib/client.js` from ~50 kB to ~480 kB. That is an accepted
cost, not an oversight — the command highlighting is a feature of the list, and
the published tarball is still only ~150 kB compressed.

Do NOT "fix" the size by externalising shiki: the table cannot answer
`require('shiki')`, so that is a guaranteed runtime throw (see the rule above),
not a smaller bundle.

## The development loop

- **Client change**: `pnpm run build`, then **restart `dsh web`** and reload the
  page. The host reads `lib/client.js` when it boots and serves those bytes; with
  no bundle watcher running, a page refresh alone keeps serving the boot-time
  bundle — and a stale bundle looks exactly like a broken component (this cost a
  real debugging round: a style change was visible in the build and absent on
  screen). Only while `pnpm run dev:web` is watching does a refresh suffice.
- **Host change**: `pnpm run build`, then restart `dsh web`. The host imports
  `lib/index.js` once, at start-up.
- **Plugin resolution change** (a new dependency under `dsh.client.external`,
  for instance): restart DSH. Package metadata is cached per loader entry.

To develop against a local checkout:

```sh
dsh plugin --profile web add ./            # or the absolute path to this repo
```

## The two invariants

**1. The marker is inlined.** `src/instrument.ts` has the full story. A helper
function that writes the marker is a command of its own, so it overwrites `$?`
and the instrumented command reads a different value than the plain one.
`tests/powershell.spec.ts` asserts this against a real `pwsh`.

**2. The client bundle must stay pure.** `build/tsdown.client.ts` fails the
build on any `@deepseek-ai/*` *value* import that is not a platform module
(`build/platform.ts`), an inline-safe wire layer, or a generated `/remote`
contribution. Cross-plugin collaboration goes through cordis services, and
type-only imports are erased and always fine.

## Testing

| File | Covers |
|---|---|
| `tests/split.spec.ts` | The splitter, including the six brace-scanning probes. |
| `tests/instrument.spec.ts` | Marker shape, line preservation, stripping, collision guards. |
| `tests/parse.spec.ts` | Delta reassembly: markers and lines split across reads. |
| `tests/tracker.spec.ts` | Attribution, monotonic timings, output budget. |
| `tests/run.spec.ts` | The poll loop, against a scripted process handle. |
| `tests/render.spec.ts` | Model-visible text, marker for marker. |
| `tests/model.spec.ts` | View derivation and defensive narrowing. |
| `tests/store.spec.ts` | Poll lifecycle, snapshot stability, refcounting. |
| `tests/powershell.spec.ts` | **Real `pwsh`**: instrumentation changes nothing observable. |
| `tests/client-bundle.spec.ts` | The built bundle loads through the module loader and fills the slot. |
| `tests/client-render.spec.ts` | The built bundle renders the bar, its segments and its injected CSS. |
| `e2e/card.spec.ts` | **Real browser, real `dsh web`**: the card beside the native row. |

## The browser suite

```sh
pnpm run build   # the shell serves lib/, never src/
pnpm run e2e
```

It boots a throwaway `dsh web` on a random port against a temporary `DSH_HOME`,
links this package into that profile, and screenshots the card from a page. It
never touches a running harness: `e2e/helpers/host.ts` starts and stops only the
child it spawned, and the port is proven free by binding it first.

Getting a tool card on screen with no model to call one is the interesting part.
A fixture cordis plugin (`e2e/fixtures/seed-session.mjs`, mounted through
`--patch`) publishes ONE live session carrying a fabricated `pwsh` call and a
fabricated `shell_progress` call, so the real client renders both cards from real
session data. Three host facts make that work, and each one costs a debugging
cycle if forgotten:

- the session service is `ctx.sessions` (not `sessionController`), and
  `create()` publishes a **live** session — a session published outside the agent
  lifecycle is never written to disk, so its id is read from the host log, not
  from the sessions directory;
- `header.cwd` must be absolute and present, or the client's follow rejects the
  session as "not found";
- the open session is a **persisted client store**
  (`localStorage['dsh.sessions.current']`), and the client's `restoreSelection`
  only honours it for a session that is not `blank` — which only `turn/start`
  clears.

Screenshots land in `test-results/` (`shell-progress-card.png`, plus `-expanded`,
`-running` and `-hover-card` variants). That is the point of the suite: "does this
look like the shell's own row?" is a question about pixels, and two real bugs — a
bar collapsed to zero width and a chevron on the wrong side — were invisible to
every unit test and obvious in one screenshot.

### The two committed figures, and the duty that comes with them

The same run also writes the only images the repository tracks, each CROPPED to the
card itself:

| File | Language | Shown by |
|---|---|---|
| `docs/assets/running.png` | English | `README.md` |
| `docs/assets/running.zh.png` | Chinese | `README.zh.md` |

**A UI change is not finished until both are regenerated**: run `pnpm run e2e` and
commit the two images it rewrites. They are photographs, so a stale pair keeps
asserting something about the card that stopped being true — and nothing catches it:
the build, the type checker and every test stay green while both READMEs display the
old pixels.

Each figure is shot against its OWN host, because the card's title is the shell's own
text and the language comes from that host's stored `locale.preference`
(`makeFixture(tag, locale)`), never from the browser: the client's browser-derived
language is provisional and is replaced once the plugin activates. That is why an
`en-US` browser context produced an English figure on one run and a Chinese one on the
next. The capture waits for the title it expects (`toContainText`) before the shutter,
and takes the shot in its own context at `README_FIGURE_WIDTH`, so neither the wait nor
the narrow viewport can disturb the measurements the rest of the file makes.

The last one skips itself when no `pwsh` can be spawned, so a sandbox boundary
reads as a skip rather than a false failure.

## Known limits

What this plugin knowingly does not do, and what it does not verify, is written down with its evidence in [`docs/known-limits.md`](docs/known-limits.md).

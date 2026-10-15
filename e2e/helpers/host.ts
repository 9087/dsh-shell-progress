/**
 * Host-process plumbing for the real-browser E2E: resolve a `dsh` executable,
 * boot `dsh web` against a throwaway `DSH_HOME` with this plugin linked into its
 * profile, and tear exactly that process down again.
 *
 * Adapted from `dsh-diff-approval`'s `e2e/helpers/host.ts` (MIT), which is the
 * working precedent for this shape. Two of its rules are load-bearing here too:
 *
 * - **Nothing may end a process this file did not start.** `stopHost` kills the
 *   exact child it spawned, and only that child's own tree by PID as a last
 *   resort. `dsh web` on 3080 is the user's session — this suite must never
 *   touch it, and never guesses a PID.
 * - **A port must be proven free by binding it.** Windows reserves whole ranges,
 *   so a random number can land somewhere `listen` fails with `EACCES`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/** Repository root: the package the throwaway profile links to. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The package under test, as the profile must name it. */
export const PACKAGE = 'dsh-shell-progress'

/** A `dsh` invocation, split into the executable and the arguments before the command. */
export interface DshCommand {
  cmd: string
  prefix: string[]
  /** How this was found, for the report. */
  via: string
}

/**
 * Find the `dsh` CLI.
 *
 * Order: `DSH_BIN` (an explicit instruction always wins) → the `dsh` shim on
 * `PATH`, whose sibling `@deepseek-ai/dsh/lib/bin.js` is spawned directly with
 * the current Node → an `npx` cache install, which is how this plugin's own
 * development machine runs the harness. A machine with none of those is a
 * machine this suite cannot run on: the caller skips instead of failing.
 * @returns the resolved command, or undefined when no `dsh` can be found.
 */
export function resolveDsh(): DshCommand | undefined {
  const explicit = process.env.DSH_BIN
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) {
    if (/\.(js|mjs|cjs)$/i.test(explicit)) return { cmd: process.execPath, prefix: [explicit], via: 'DSH_BIN' }
    return { cmd: explicit, prefix: [], via: 'DSH_BIN' }
  }
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (dir === '') continue
    const entry = join(dir, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(entry)) return { cmd: process.execPath, prefix: [entry], via: `PATH shim in ${dir}` }
  }
  // Local convenience only: `npx @deepseek-ai/dsh` leaves the package in the
  // npm cache under an opaque hash, and SEVERAL versions can be cached side by
  // side — picking by directory order once chose 0.1.5-rc.1 while the machine
  // actually runs 0.2.0-rc.2, and the two disagree about both the API surface
  // and where `--patch` belongs. Take the newest; `DSH_BIN` pins one explicitly.
  const npxRoot = join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
  if (existsSync(npxRoot)) {
    let best: { entry: string; via: string; version: number[] } | undefined
    for (const hash of readdirSync(npxRoot)) {
      const pkg = join(npxRoot, hash, 'node_modules', '@deepseek-ai', 'dsh')
      const entry = join(pkg, 'lib', 'bin.js')
      if (!existsSync(entry)) continue
      const version = readVersion(join(pkg, 'package.json'))
      if (best === undefined || compareVersions(version, best.version) > 0) {
        best = { entry, via: `npx cache ${hash} (${version.join('.')})`, version }
      }
    }
    if (best !== undefined) return { cmd: process.execPath, prefix: [best.entry], via: best.via }
  }
  return undefined
}

/** The numeric part of a package's version, or zeros when it cannot be read. */
function readVersion(packageFile: string): number[] {
  try {
    const version = (JSON.parse(readFileSync(packageFile, 'utf8')) as { version?: unknown }).version
    if (typeof version !== 'string') return [0, 0, 0]
    return version.split('-')[0]!.split('.').map((part) => Number.parseInt(part, 10) || 0)
  } catch {
    return [0, 0, 0]
  }
}

/** Compare two numeric versions, ignoring any prerelease suffix. */
function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** One booted host: the child process, its base URL (with the browser token), and its log. */
export interface Host {
  proc: ChildProcess
  url: string
  port: number
  logFile: string
}

/** A port nothing else is on, checked by actually binding it. */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 30_000)
    if (await canBind(port)) return port
  }
  throw new Error('no bindable port found in 20000..50000 after 40 tries')
}

/** Whether this process can listen on one port right now (and let it go again). */
async function canBind(port: number): Promise<boolean> {
  return await new Promise<boolean>((settle) => {
    const probe = createServer()
    probe.once('error', () => { settle(false) })
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => { settle(true) })
    })
  })
}

/**
 * Start `dsh web` with a private home and wait until it prints its URL.
 * @param dsh - the resolved CLI.
 * @param home - the throwaway `DSH_HOME`; all user data lands under it.
 * @param workspace - the host's working directory (the session's workspace root),
 *   also exported to the child as `DSH_E2E_WORKSPACE` so a fixture plugin can
 *   give the session it publishes an absolute cwd.
 * @param logFile - where the child's stdout+stderr go. A FILE, not a pipe: the
 *   output is what the URL is parsed from, and it is the post-mortem when a boot
 *   fails.
 * @param extraArgs - extra CLI arguments, e.g. `['--patch', …]` for a fixture
 *   overlay. They go immediately AFTER the `web` subcommand and before the web
 *   app's own flags: `--patch` belongs to the profile layer, while the app
 *   passes unknown options straight through and rejects them. Placing them
 *   before `web` instead makes the CLI demand an explicit `--profile`.
 * @returns the booted host.
 */
export async function startHost(
  dsh: DshCommand,
  home: string,
  workspace: string,
  logFile: string,
  extraArgs: readonly string[] = [],
): Promise<Host> {
  const port = await freePort()
  const fd = openSync(logFile, 'a')
  const proc = spawn(
    dsh.cmd,
    [...dsh.prefix, 'web', ...extraArgs, '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    {
      cwd: workspace,
      env: { ...process.env, DSH_HOME: home, DSH_E2E_WORKSPACE: workspace },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    },
  )
  const pattern = new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=\\S+`)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`dsh web exited with code ${proc.exitCode}:\n${tail(logFile)}`)
    const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    const match = pattern.exec(text)
    if (match !== null) return { proc, url: match[0], port, logFile }
    await sleep(400)
  }
  await stopHost(proc)
  throw new Error(`dsh web never printed a URL within 120s:\n${tail(logFile)}`)
}

/** The last few lines of a log, for an error message that says what actually happened. */
export function tail(file: string): string {
  if (!existsSync(file)) return '(no log)'
  return readFileSync(file, 'utf8').split('\n').slice(-30).join('\n')
}

/**
 * End exactly one host process — the one this file started.
 *
 * `kill()` first; if that child has not exited in a few seconds its OWN tree is
 * terminated by PID, which is still only the process this suite spawned. Never a
 * name, never a port, never a PID from anywhere else.
 * @param proc - the child this suite started.
 */
export async function stopHost(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise<void>((settle) => proc.once('exit', () => settle()))
  proc.kill()
  const settled = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
  if (settled || proc.pid === undefined) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolveKill) => {
      const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.once('exit', () => resolveKill())
      killer.once('error', () => resolveKill())
    })
    await Promise.race([exited, sleep(3000)])
  }
}

/** A prepared throwaway home plus the workspace the sessions live in. */
export interface Fixture {
  home: string
  workspace: string
  logFile: string
  /** Remove the whole temporary home. */
  cleanup(): void
}

/**
 * Create the temporary home/workspace pair this suite owns.
 * @param tag - names the temporary directory, so two fixtures in one file cannot collide.
 * @param locale - the STORED `locale.preference` for this home. It is written into the
 *   host's own settings document because that value is the AUTHORITATIVE language: the
 *   language the client derives from the browser is only provisional, and the stored
 *   preference REPLACES it once the plugin activates (`dsh-client-locale`). A screenshot
 *   therefore cannot be taken in a language by setting the browser's — it needs a home
 *   that says so.
 */
export function makeFixture(tag: string, locale: 'zh' | 'en' = 'zh'): Fixture {
  const home = join(tmpdir(), `dsh-shell-progress-e2e-${tag}-${randomUUID().slice(0, 8)}`)
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  // Pin the language so the card's own labels are the ones the assertions read,
  // and give the host a credential so the first-run "add an API key" modal never
  // opens: it is a modal over a mask, and a modal the browser cannot dismiss
  // makes every later click land on the mask instead of the page. It is a
  // placeholder — this suite never calls a model.
  writeFileSync(join(home, 'settings.yaml'), `locale:\n  preference: ${locale}\n`)
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-e2e-placeholder-not-a-real-key\n')
  return {
    home,
    workspace,
    logFile: join(home, 'host.log'),
    cleanup: () => { rmSync(home, { recursive: true, force: true }) },
  }
}

/**
 * First boot on a fresh `DSH_HOME`, then make this plugin part of that profile.
 *
 * `dsh web` creates `<home>/profiles/web` on its first run with only the base
 * bundles, so the plugin is added exactly the way a user's profile carries it: an
 * entry in `dsh.profile.bundles` plus a `node_modules/<package>` junction back to
 * this checkout. The workspace registry is seeded too, so the GUI has a workspace
 * to open a session in without a native directory picker (which no browser can
 * drive).
 *
 * The plugin's `lib/` must already be built: `pnpm run e2e` does not build, the
 * same way the shell serves the built bundle and not the source.
 * @param dsh - the resolved CLI.
 * @param fixture - the fixture whose home and workspace are used.
 * @returns the workspace id written into the registry.
 */
export async function bootstrapHome(dsh: DshCommand, fixture: Fixture): Promise<string> {
  const first = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
  await stopHost(first.proc)

  const profile = join(fixture.home, 'profiles', 'web')
  if (!existsSync(join(profile, 'package.json'))) {
    throw new Error(`dsh web did not create a profile at ${profile}:\n${tail(fixture.logFile)}`)
  }
  const packageFile = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  if (!manifest.dsh.profile.bundles.includes(PACKAGE)) manifest.dsh.profile.bundles.push(PACKAGE)
  manifest.dependencies[PACKAGE] = `file:${repoRoot}`
  writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`)

  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  const link = join(profile, 'node_modules', PACKAGE)
  if (!existsSync(link)) symlinkSync(repoRoot, link, 'junction')

  const workspaceId = randomUUID()
  const registryFile = join(fixture.home, 'storages', 'workspace.json')
  const registry = JSON.parse(readFileSync(registryFile, 'utf8')) as {
    global: { workspaceIds: string[] }
    tables: { workspaces: Record<string, unknown> }
  }
  registry.global.workspaceIds = [workspaceId]
  registry.tables.workspaces = {
    [workspaceId]: {
      path: fixture.workspace,
      title: basename(fixture.workspace),
      sessionIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`)
  return workspaceId
}

/** The log file inside one session directory, whatever this release calls it. */
function sessionLogOf(dir: string): string | undefined {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('session.')) return name
  }
  return undefined
}

/** The most recently written session on this home, from the session tree itself. */
export function newestSessionId(home: string): string | undefined {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return undefined
  let best: { id: string; at: number } | undefined
  for (const bucket of readdirSync(root)) {
    const bucketDir = join(root, bucket)
    for (const candidate of readdirSync(bucketDir)) {
      const dir = join(bucketDir, candidate)
      const log = sessionLogOf(dir)
      if (log === undefined) continue
      const at = statSync(join(dir, log)).mtimeMs
      if (best === undefined || at > best.at) best = { id: candidate, at }
    }
  }
  return best?.id
}

/**
 * Watch the session tree until a session exists there, or give up.
 *
 * The disk half of "which session did the host just write": the log appearing IS
 * the fact, independent of any response the browser happened to see.
 * @param home - the throwaway `DSH_HOME` to watch.
 * @param deadline - `Date.now()` after which the wait ends.
 * @returns the session id, or undefined if nothing appeared in time.
 */
export async function waitForSessionOnDisk(home: string, deadline: number): Promise<string | undefined> {
  for (;;) {
    const id = newestSessionId(home)
    if (id !== undefined) return id
    if (Date.now() >= deadline) return undefined
    await sleep(200)
  }
}

/** Everything currently under the seedable directories, for a failure message. */
export function describeHome(home: string): string {
  const parts: string[] = []
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) parts.push('sessions: (missing)')
  else {
    const listed: string[] = []
    for (const bucket of readdirSync(sessions)) {
      const ids = readdirSync(join(sessions, bucket)).slice(0, 6).map((id) => {
        const log = sessionLogOf(join(sessions, bucket, id))
        return log === undefined ? `${id}(no log)` : `${id}(${log})`
      })
      listed.push(`${bucket}: ${ids.length === 0 ? '(empty)' : ids.join(', ')}`)
    }
    parts.push(`sessions: ${listed.join(' | ') || '(empty)'}`)
  }
  const profile = join(home, 'profiles', 'web', 'package.json')
  parts.push(`profile: ${existsSync(profile) ? 'present' : '(missing)'}`)
  return parts.join('\n')
}

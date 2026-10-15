/**
 * The parse-based step planner for bash: ask tree-sitter's bash grammar where
 * the top-level statements begin.
 *
 * `./bash.ts` cannot decide this. Its splitter tracks brace and paren depth,
 * which is why every keyword-delimited block (`if`/`then`/`fi`, `for`/`do`/
 * `done`, `case`/`esac`) is simply REFUSED there: without a parser there is no
 * way to know where such a block ends, and a guessed boundary lands a marker
 * inside it. This module supplies the missing parser. tree-sitter compiles the
 * bash grammar to WebAssembly, the runtime loads it (see `vendor/README.md`
 * for the artifact's provenance), and the ROOT NODE'S NAMED CHILDREN are the
 * authoritative list of top-level statements: each one's
 * `startPosition.row + 1` is a step boundary that cannot be wrong. A block
 * contributes ONE child, whose start row is its opening line, so `if`/`for`/
 * `while`/`case` bodies never become steps.
 *
 * ## The trap
 *
 * A tree-sitter parse of broken input does not fail: it returns a TREE, whose
 * root carries an `ERROR` (or `MISSING`) node and whatever top-level children
 * the parser could still make out. `if true; then` with no `fi` is refused by
 * this planner precisely because `hasError` is set, not because the root came
 * back empty. Exactly like PowerShell's best-effort statement list, the tree is
 * NEVER trusted on its own: {@link planBashSteps} refuses the whole plan
 * whenever `tree.rootNode.hasError`, which is true for any `ERROR` or `MISSING`
 * node anywhere in the tree.
 *
 * ## The tree's lifetime
 *
 * The host is LONG-LIVED — one process serves every tool call — and each call
 * that needs a plan parses once. A `Tree` is a wasm-side allocation that no
 * garbage collector can see, so a tree that is merely dropped grows the process
 * until a finalizer happens to run. This module therefore reads the top level's
 * line numbers OUT of the tree and then RELEASES the tree (`tree.delete()`), on
 * every path — the `hasError` refusal included. Only the cached {@link Parser},
 * its language and the init promise outlive a call; those are the expensive,
 * shareable part and are deliberately never released. See
 * {@link planBashSteps} for the shape that guarantees it.
 *
 * ## Why every failure is `undefined`
 *
 * `plan` is consulted by `./index.ts`'s `resolveSplit`, which treats a missing
 * answer as a REFUSAL for a dialect that ships a planner — never as a licence
 * to fall back to the heuristic. So this module has one job beyond planning:
 * never throw into the tool path. The grammar file may be absent from a
 * partial install, `Parser.init()` may fail, the wasm may be corrupt, and the
 * parse itself may throw; each of those returns `undefined` ("no authoritative
 * answer"), and the command then runs unmodified.
 *
 * ## Why a load can fail, and why the failure is cached
 *
 * The failure this module tolerates is not hypothetical, and every mode of it is
 * an INSTALL problem rather than a runtime one:
 *
 * - the vendored `.wasm` missing, because a partial install dropped it or the
 *   published tarball's `files` list no longer carries `vendor/…`;
 * - the same file present but corrupt or truncated (a broken download, a partial
 *   write, an editor that re-encoded it);
 * - `web-tree-sitter` itself missing, so the lazy `import` above cannot resolve;
 * - the grammar URL not pointing at the package directory at all — the plugin
 *   copied or symlinked somewhere that breaks `../vendor`, or a bundler
 *   rewriting the module URL into something no filesystem call can open (the
 *   reason `MODULE_DIR` above prefers `import.meta.dirname`);
 * - a read-permission problem on either the loader package or the `.wasm`;
 * - an incompatible-Node edge case in the loader's own emscripten module.
 *
 * What is NOT on that list is a CPU or ABI mismatch, because a WebAssembly
 * grammar cannot have one: the artifact is consumed by the wasm runtime inside
 * `web-tree-sitter`, not by the host's native code, so `x64` versus `arm64`,
 * or a different libc, changes nothing about loading it.
 *
 * Each of these degrades to a REFUSAL: {@link planBashSteps} answers `undefined`,
 * and `./index.ts`'s `resolveSplit` turns that into "run the command exactly as
 * written" rather than a guessed split. That is what makes caching the FAILURE
 * acceptable — the plugin loses only the bar, never correctness — and the cost
 * is bounded to the process's lifetime: the degraded state lasts until the host
 * restarts against a repaired install. A retry would not shorten it, because the
 * file a retry would read is the same broken one.
 *
 * ## The import cycle with `./bash.ts`
 *
 * This module asks the dialect's own heuristic whether there is anything to
 * decide at all, and `./bash.ts` needs this module to expose the planner as
 * `plan`. Both are function declarations, which are initialised during module
 * instantiation — before any module body runs — so neither side reads an
 * uninitialised binding.
 *
 * @module dsh-shell-progress/bashtree
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Parser as TreeSitterParser, Tree } from 'web-tree-sitter'
import { splitBash } from './bash.ts'
import { stepsAtLines } from './plan.ts'
import type { SplitResult } from './split.ts'

/**
 * The directory this module itself lives in.
 *
 * `import.meta.url` is the canonical way to name a module's own location, and
 * the host runs this file as real ESM, where it is a `file:` URL. It is NOT
 * always one: a bundler-backed test runner serves transformed modules from its
 * own http origin and rewrites `import.meta.url` to `http://localhost:...`,
 * which no filesystem call can open. `import.meta.dirname` is the same fact,
 * computed by the runtime from that same URL, and is not rewritten — so it is
 * preferred, with the URL form as the fallback for a runtime without it.
 */
const MODULE_DIR: string = (import.meta as ImportMeta & { readonly dirname?: string }).dirname
  ?? fileURLToPath(new URL('.', import.meta.url))

/**
 * The vendored grammar, addressed from THIS MODULE's own directory — never
 * `process.cwd()`.
 *
 * Both the source file (`src/bashtree.ts`) and the host bundle it is compiled
 * into (`lib/index.js`) sit one directory below the package root, so `../vendor`
 * names the same published file in a test run and in an installed copy. A plugin
 * is loaded from an arbitrary working directory, so a cwd-relative path would
 * simply not find the file.
 */
export const GRAMMAR_URL: URL = pathToFileURL(join(MODULE_DIR, '..', 'vendor', 'tree-sitter-bash.wasm'))

/**
 * The process-wide parser, or the permanently failed attempt to build one.
 *
 * Both `Parser.init()` (which instantiates the loader's own emscripten module)
 * and the 1.3 MB grammar load happen behind this ONE cached promise.
 */
let parserPromise: Promise<TreeSitterParser | undefined> | undefined

/**
 * Load a parser for one grammar file.
 *
 * The `existsSync` guard runs first so a missing file is reported without waking
 * the wasm runtime at all. Nothing here may reject, whichever of those steps
 * fails first.
 *
 * `Language.load` accepts a `URL`, which is what keeps the grammar addressed
 * relative to this module rather than to the current directory.
 * @param grammarUrl - the grammar to load; the vendored one in production.
 * @returns a parser that may be asked about a command, or undefined.
 */
export async function loadBashParser(grammarUrl: URL = GRAMMAR_URL): Promise<TreeSitterParser | undefined> {
  try {
    if (!existsSync(fileURLToPath(grammarUrl))) return undefined
    // Imported lazily so a broken/absent loader package disables bash planning
    // instead of failing the whole plugin's module load — the pwsh half, which
    // shares this build, must still work.
    const { Language, Parser } = await import('web-tree-sitter')
    await Parser.init()
    const language = await Language.load(grammarUrl)
    const parser = new Parser()
    parser.setLanguage(language)
    return parser
  } catch {
    // A corrupt or substituted grammar throws out of `Language.load`, and a
    // partial install can fail to resolve the loader at all. Neither may reach
    // the tool path, so both are "no parser".
    return undefined
  }
}

/**
 * The shared parser, built at most once per process.
 *
 * FAILURE IS CACHED, deliberately. `??=` keeps the FIRST promise — including
 * the one that resolves to `undefined` for a broken install — so an absent or
 * corrupt grammar pays for the attempt once instead of re-reading and
 * re-compiling 1.3 MB of WebAssembly on every single tool call. A later call
 * could not heal the install anyway: the file it would read is the same one.
 * @returns the parser, or undefined when this process has no usable grammar.
 */
export function sharedBashParser(): Promise<TreeSitterParser | undefined> {
  parserPromise ??= loadBashParser()
  return parserPromise
}

/**
 * Parse one command, treating any failure as "no answer".
 *
 * `parser.parse` returns `null` for a parse it could not start, and throwing
 * is not something a caller of this module may ever see.
 * @param parser - the loaded parser.
 * @param command - the command text.
 * @returns the tree, or undefined.
 */
function parseTree(parser: TreeSitterParser, command: string): Tree | undefined {
  try {
    return parser.parse(command) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * The authoritative, parse-based plan for one bash command.
 *
 * The parse is skipped when it cannot change the outcome — a single-line
 * command, whose split is already correct, and a command the heuristic has
 * already split into at most one step — and `undefined` is returned whenever
 * the grammar cannot be loaded or the parse cannot be trusted to have run. The
 * caller then refuses the command rather than falling back to a guessed
 * boundary.
 *
 * ## Why an UNSAFE heuristic is parsed, not skipped
 *
 * `./bash.ts`'s heuristic REFUSES every keyword-delimited block: `if`/`then`/
 * `fi`, `for`/`do`/`done`, `while`, `case`, `{ … }` and `function` all come
 * back `safe: false`, because a brace counter genuinely cannot find their end.
 * Those are exactly the commands this planner exists to answer, so
 * `heuristic.safe === false` is the case that MUST be parsed. Skipping it (the
 * way `./pwshtree.ts` skips a broken PowerShell script) would leave the planner
 * unable to plan anything the heuristic could not already handle, and every
 * block would stay uninstrumented. The skip is therefore narrowed to the
 * commands with no boundary to decide at all: one source line, or a heuristic
 * answer that is safe and holds at most one step.
 * @param command - the command text, exactly as it will be executed.
 * @returns the plan, or undefined when there is no authoritative answer.
 */
export async function planBashSteps(command: string): Promise<SplitResult | undefined> {
  const heuristic = splitBash(command)
  // A single DETERMINED step has no boundary to decide, so parsing it would buy
  // nothing but a wasm load. An unsafe heuristic is NOT that case — see above.
  if (heuristic.safe && heuristic.steps.length <= 1) return undefined
  // One source line cannot hold two top-level steps in the line-based step
  // model, and the caller uninstruments such a command on its own.
  if (!/[\r\n]/.test(command)) return undefined
  const parser = await sharedBashParser()
  if (parser === undefined) return undefined
  const tree = parseTree(parser, command)
  if (tree === undefined) return undefined
  // The tree is released on EVERY path out of this block, the refusal below
  // included: `finally` runs before the `return` completes. See the module
  // header — a long-lived host would otherwise accumulate one wasm tree per
  // tool call. Everything read out of the tree is read BEFORE the release: the
  // nodes are views into it, and `delete()` invalidates them.
  try {
    const root = tree.rootNode
    // THE TRAP: a syntax error does not stop tree-sitter — it decorates the tree
    // with `ERROR`/`MISSING` nodes and still reports top-level children. The
    // error flag is what decides, and the partial tree is never read.
    if (root.hasError) {
      return {
        // A refusal plans NO steps: it is not a guess, and the card's notice
        // hangs on the refusal signal rather than on a step count.
        steps: [],
        safe: false,
        reason: 'the bash parser reported a syntax error in this command',
      }
    }
    // The root's NAMED children are the top-level statements; a block form is
    // ONE child whose start row is the line that opens it.
    const lines = root.namedChildren.map((child) => child.startPosition.row + 1)
    return { steps: stepsAtLines(command, lines), safe: true }
  } finally {
    tree.delete()
  }
}

/**
 * Syntax highlighting for the step list's command lines.
 *
 * Modelled on `dsh-diff-approval`'s viewer: Shiki's fine-grained core with the
 * JavaScript regex engine (no oniguruma WASM), and token colours resolved through the
 * `--shiki-*` custom properties the harness theme already ships — dark overrides
 * included — so the colours follow the theme instead of being pinned here.
 *
 * ONLY A COMMAND IS A LANGUAGE. A step's output is arbitrary terminal text with no
 * grammar at all, so it is rendered plain: guessing there would colour noise, and
 * colour that means nothing is worse than no colour.
 *
 * @module dsh-shell-progress/client/highlight
 */

import type { CSSProperties } from 'react'
import { createCssVariablesTheme, createHighlighterCoreSync } from 'shiki/core'
import type { HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor } from 'shiki/engine/javascript'
import langPowershell from '@shikijs/langs/powershell'
import langShellscript from '@shikijs/langs/shellscript'

/** One highlighted run of a command line. */
export interface HighlightRun {
  readonly text: string
  /** The token's colour and weight, or undefined for the plain foreground. */
  readonly style: CSSProperties | undefined
}

/** The grammar one of our dialects' commands is read in. */
const LANG_BY_TOOL: Readonly<Record<string, string>> = {
  shell_progress_pwsh: 'powershell',
  shell_progress_bash: 'shellscript',
}

/**
 * The grammar a tool's commands are written in, or undefined for plain text.
 * @param toolName - the registered tool name, e.g. `shell_progress_pwsh`.
 * @returns a Shiki grammar id, or undefined when the tool is not one of ours.
 */
export function commandLanguage(toolName: string): string | undefined {
  return LANG_BY_TOOL[toolName]
}

/** `--shiki-*` is the theme's own token sheet; see `dsh-client-ui-theme`. */
const cssVariablesTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  fontStyle: true,
})

/**
 * The client regex engine compiles each TextMate pattern when its scanner is created,
 * and Shiki otherwise defers patterns longer than 3,000 characters until their first
 * match. Compiling eagerly keeps that cost off the first command we highlight.
 */
const engine = createJavaScriptRegexEngine({
  forgiving: true,
  regexConstructor: (pattern) => defaultJavaScriptRegexConstructor(pattern, {
    lazyCompileLength: Number.POSITIVE_INFINITY,
  }),
})

let singleton: HighlighterCore | undefined

function highlighter(): HighlighterCore {
  singleton ??= createHighlighterCoreSync({
    themes: [cssVariablesTheme],
    // Only the two grammars this plugin can meet: a command is PowerShell or bash.
    langs: [langPowershell, langShellscript],
    engine,
  })
  return singleton
}

/** Bit flags Shiki sets on a token; the values are vscode-textmate's. */
const ITALIC = 1
const BOLD = 2

function styleOf(token: { readonly color?: string; readonly fontStyle?: number }): CSSProperties | undefined {
  const style: CSSProperties = {}
  if (token.color !== undefined) style.color = token.color
  const flags = token.fontStyle ?? 0
  if ((flags & ITALIC) !== 0) style.fontStyle = 'italic'
  if ((flags & BOLD) !== 0) style.fontWeight = 'bold'
  return Object.keys(style).length === 0 ? undefined : style
}

/**
 * Tokenise cache. The step list re-renders on every live clock tick, and a command's
 * text never changes once split, so the same handful of lines would otherwise be
 * re-tokenised every second. Bounded, because a command can have hundreds of steps.
 */
const cache = new Map<string, HighlightRun[]>()
const CACHE_MAX = 128

/**
 * Highlight one command line.
 * @param text - the command, as split out of the tool call.
 * @param toolName - the tool that ran it; unknown tools come back undefined.
 * @returns the runs to render, or undefined when the line should stay plain.
 */
export function highlightCommand(text: string, toolName: string): HighlightRun[] | undefined {
  const lang = commandLanguage(toolName)
  if (lang === undefined) return undefined
  const key = `${lang}\u0000${text}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  let runs: HighlightRun[]
  try {
    const lines = highlighter().codeToTokens(text, { lang, theme: 'css-variables' }).tokens
    runs = (lines[0] ?? []).map((token) => ({ text: token.content, style: styleOf(token) }))
  } catch {
    // A grammar this line trips is not worth losing the command over: plain text is the
    // honest fallback, and the gate on the caller's side is `undefined`.
    return undefined
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, runs)
  return runs
}

// Engine and grammar construction is a long task, and the first card the reader opens
// should not pay for it: warm the singleton in a deferred task at module load.
const warmup = setTimeout(() => {
  highlightCommand('Write-Output "$env:PATH"', 'shell_progress_pwsh')
  highlightCommand('printf \'%s\\n\' "$HOME"', 'shell_progress_bash')
}, 0)

// Node-side imports of this module (tests) must not pin the event loop.
if (typeof warmup === 'object' && 'unref' in warmup) warmup.unref()

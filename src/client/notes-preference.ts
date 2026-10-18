/**
 * The switch behind the step notes: one boolean, remembered per browser.
 *
 * WHY IT LIVES CLIENT-SIDE. The note is written by the HOST (it is the party that can reach
 * the model), but the switch that governs it belongs to the reader's interface — and this
 * plugin already tells the host what it needs to know over its own progress channel (see
 * `pushNotePreference` in `index.ts`). So the preference is stored where it is used and
 * pushed to the host on change, instead of the host reading a settings document it has no
 * business knowing about.
 *
 * Storage failures are tolerated ON PURPOSE. A browser in private mode, or a profile with
 * storage disabled, throws on `localStorage` access; the answer is the default for this page
 * rather than an exception on every render of the settings page.
 *
 * @module dsh-shell-progress/client/notes-preference
 */

/** Where the switch is kept. */
const KEY = 'dsh-shell-progress.step-notes'

/** The value for this page, read once and then kept in memory. */
let current: boolean | undefined

/** Whoever needs to hear about a flip: the host push in `index.ts`. */
const listeners = new Set<(enabled: boolean) => void>()

/**
 * Whether the model may write step notes.
 * @returns the reader's preference, defaulting to ON.
 */
export function notesEnabled(): boolean {
  if (current !== undefined) return current
  try {
    // Anything but an explicit '0' is the default: a first visit, a cleared store, or a
    // value written by a future version all mean "leave it on".
    current = window.localStorage.getItem(KEY) !== '0'
  } catch {
    current = true
  }
  return current
}

/**
 * Turn the notes on or off, remember it, and tell the listeners.
 * @param enabled - the new preference.
 */
export function setNotesEnabled(enabled: boolean): void {
  current = enabled
  try {
    window.localStorage.setItem(KEY, enabled ? '1' : '0')
  } catch {
    // Not remembered past this page — see the module comment. The switch still works.
  }
  for (const listener of listeners) listener(enabled)
}

/**
 * Hear about a flip, so the host can be told.
 * @param listener - called with the new preference.
 * @returns the unsubscribe.
 */
export function onNotesEnabledChange(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The interface language the notes must be written in, as last told by the shell. */
let activeLanguage: string | undefined

/**
 * Remember the active interface language, so a LAZY notes request asks for the right one.
 * @param id - the active language's id, e.g. `zh-CN`.
 */
export function setNotesLocale(id: string): void {
  activeLanguage = id.length > 0 ? id : undefined
}

/**
 * The language the notes must be written in.
 * @returns the last id the shell reported, or `undefined` before it said.
 */
export function notesLocale(): string | undefined {
  return activeLanguage
}

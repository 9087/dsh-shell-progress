/**
 * Browser half of the step-progress plugin: one tool-call view for
 * `shell_progress`.
 *
 * The row is registered into the `tool.call.toolview` keyed slot under this
 * plugin's own tool name, so it neither shadows a shipped card nor needs a
 * priority. Registration goes through `slots.inject` because the slot belongs
 * to another package: that is what makes the contribution wait for the slot's
 * declaration, leave with this plugin's fiber, and survive a redeclaration.
 *
 * @module dsh-shell-progress/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { TOOL_NAMES } from '../types.ts'
import { en, NS, zh } from './locales.ts'
import { createProgressPort } from './port.ts'
import { SettingsSection } from './SettingsSection.tsx'
import { notesEnabled, onNotesEnabledChange } from './notes-preference.ts'
import { ShellProgressRow } from './Row.tsx'
import type { ShellProgressFace } from './Row.tsx'
import { createProgressStore } from './store.ts'

/** Stable plugin name, mirroring the host half's `shell-progress`. */
export const name = 'ui-shell-progress'

/** Required services. */
export const inject: string[] = ['slots', 'locale', 'connection']

/**
 * The slice of the SlotRegistry this plugin uses.
 *
 * Declared locally rather than imported so a shell that renames or narrows a
 * registration option cannot stop this plugin from loading; the component's
 * own props stay fully typed, which is where the contract actually matters.
 */
interface SlotsService {
  inject(name: string, callback: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): unknown
}

/** The slice of the locale service this plugin uses. */
interface LocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  /**
   * Bind this plugin's namespace to a translator, the way the shell's own plugins do.
   *
   * This is the ONE way to render copy in the right language: it resolves a key through the
   * ACTIVE language at the moment it is called, the host's stored preference included — which
   * is what makes a Chinese interface read Chinese.
   */
  bind?(namespace: string): (key: string) => string
  /** The shell's current locale; its snapshot names the language the reader is reading. */
  getLocale?(): unknown
}

/** The one field read off that snapshot, checked rather than assumed. */
interface LocaleSnapshotLike {
  readonly id?: unknown
}

/**
 * The one locale event this plugin listens for.
 *
 * Declared locally for the same reason the services above are: subscribing to it must not
 * make this plugin depend on the package that declares it. The handler may be given the new
 * snapshot, and the push prefers the id it carries — that is the shell saying "the language
 * is now X", which is more trustworthy than re-reading the current one.
 */
interface LocaleEvents {
  on(event: 'locale/change', handler: (snapshot?: unknown) => void): () => void
}

/** Register the tool-call view. */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: SlotsService }).slots
  const locale = (ctx as unknown as { locale: LocaleService }).locale
  const connection = (ctx as unknown as { connection: ConnectionHandle }).connection

  const port = createProgressPort(connection.rpc)
  const store = createProgressStore(port)

  /**
   * Tell the host which language to write step notes in, and whether to ask for them.
   *
   * The HOST makes the model request, but the GUI is the only party that knows what
   * language the reader is reading — the host-side locale lives in a stored settings
   * document this plugin does not read — so the two agree through this one call. The host
   * requests NOTHING until it is told: a note in the wrong language is worse than no note.
   *
   * A locale we cannot read is reported rather than swallowed: leaving the language at
   * whatever it was is right, but going quiet about WHY the notes never appear is not, and
   * that is the failure a reader would otherwise have to guess at.
   */
  const pushNotePreference = (changed?: unknown): void => {
    // The id comes from the CHANGED snapshot when the shell hands one over — that is the
    // shell saying which language is now active — and from the current snapshot otherwise.
    const snapshot = (changed ?? locale.getLocale?.()) as LocaleSnapshotLike | undefined
    const id = typeof snapshot?.id === 'string' && snapshot.id.length > 0 ? snapshot.id : undefined
    if (id === undefined) {
      console.warn('shell-progress: the locale service named no language, so step notes stay off')
      return
    }
    void port.configure({ enabled: notesEnabled(), locale: id })
  }

  /**
   * This plugin's translator, built the way the shell's own plugins build one.
   *
   * `bind` resolves a key through the ACTIVE language at the moment it is called, so the
   * Settings tab reads `命令进度` in a Chinese interface and `Shell Progress` in an English
   * one, the host's stored preference included.
   *
   * This REPLACED a version that read `getLocale().id` and picked between the two shipped
   * dictionaries by hand, with a silent English fallback for an id it could not read. That
   * fallback was the bug: the tab stayed `Shell Progress` in a Chinese interface and nothing
   * anywhere said so. The dictionary lookup below is the last resort for a host without
   * `bind`, not the mechanism.
   */
  const t = (key: string): string => {
    const bound = locale.bind?.call(locale, NS)
    if (typeof bound === 'function') return bound(key)
    const snapshot = locale.getLocale?.() as LocaleSnapshotLike | undefined
    const id = typeof snapshot?.id === 'string' ? snapshot.id : ''
    return (id.startsWith('zh') ? zh : en)[key as keyof typeof en] ?? key
  }
  ctx.effect(() => {
    pushNotePreference()
    return () => {}
  }, 'ui-shell-progress: note preference')
  // A switch of language changes the language the notes must be written in.
  ctx.effect(
    () => (ctx as unknown as LocaleEvents).on('locale/change', (snapshot) => { pushNotePreference(snapshot) }),
    'ui-shell-progress: locale change',
  )

  ctx.effect(() => locale.register(NS, { en, zh }), 'ui-shell-progress: dictionaries')
  // A reconnected transport invalidates every open poll: the host generation
  // that owned those calls is gone, and stale numbers are worse than none.
  ctx.effect(() => ctx.on('connection/reset', () => { store.reset() }), 'ui-shell-progress: transport reset')

  const face = (): ShellProgressFace => ({
    hooks: { progress: store },
    watchCall: (callId) => store.watch(callId),
  })

  // One view per wire name the host registers. The two are registered in separate
  // try/catches on purpose: a refused seat must cost that one dialect's card, not
  // the other's, and a name with no view silently falls back to the generic tool
  // row — a progress bar that simply never appears.
  for (const toolName of TOOL_NAMES) {
    try {
      slots.inject('tool.call.toolview', () => slots.register({
        name: 'tool.call.toolview',
        key: toolName,
        locale: NS,
        inject: face,
      }, ShellProgressRow))
    } catch (error) {
      // A refused seat must cost this one surface, not the whole client boot.
      console.error(`shell-progress could not fill tool.call.toolview for ${toolName}:`, error)
    }
  }

  // The switch, wired to the host: flipping it re-sends the preference, so the next command
  // either asks the model or does not. Without this the switch would only change what the
  // settings page looks like.
  ctx.effect(() => onNotesEnabledChange(() => { pushNotePreference() }), 'ui-shell-progress: note switch')

  // This plugin's page in DSH Settings, seated in its OWN guard: a host that refuses this
  // must cost the settings page, never the card above.
  try {
    slots.inject('settings.section', () => slots.register({
      name: 'settings.section',
      id: 'shell-progress',
      order: 100,
      label: () => t('settings.tabLabel'),
      locale: NS,
    }, SettingsSection))
  } catch (error) {
    console.error('shell-progress could not seat its settings section:', error)
  }
}

export { NS } from './locales.ts'
export { createProgressStore } from './store.ts'
export { createProgressPort } from './port.ts'
export { ShellProgressRow } from './Row.tsx'
export * from './model.ts'

/**
 * DSH Settings section for this plugin: the one switch that governs step notes.
 *
 * The shell owns the page — its frame, its heading, its language — and this file is only the
 * row inside it. That is why it is registered as a `settings.section` with `locale: NS` (see
 * `index.ts`): the translator arrives as a prop, already bound to this plugin's dictionary.
 *
 * The switch is a `role="switch"` BUTTON, not a checkbox input: the shell's own rows are
 * buttons, and a native checkbox would drag the browser's form styling into a page the shell
 * draws itself. `aria-checked` carries the state, so it is a switch to a screen reader too.
 *
 * @module dsh-shell-progress/client/SettingsSection
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { notesEnabled, setNotesEnabled } from './notes-preference.ts'
import css from './SettingsSection.module.css'

/**
 * Props the shell's settings slot renderer passes. Only the translator is used, and it is
 * declared here rather than imported from the shell — the same rule the rest of this
 * plugin's client follows: a renamed or narrowed shell prop must not stop this page loading.
 */
export interface SettingsSectionProps {
  /** Translator bound to this plugin's namespace. */
  readonly t: (key: string) => string
}

/**
 * The switch row.
 * @param props - the shell's translator.
 * @returns the row.
 */
export function SettingsSection({ t }: SettingsSectionProps): ReactNode {
  const [enabled, setEnabled] = useState(notesEnabled)
  return (
    <div className={css.row} data-shell-progress-settings="true">
      <div className={css.text}>
        <div className={css.title}>{t('settings.notes')}</div>
        <div className={css.desc}>{t('settings.notesDesc')}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={t('settings.notes')}
        className={css.switch}
        data-enabled={enabled ? 'true' : 'false'}
        onClick={() => {
          // Both halves matter: the module is the truth the host push reads, the state is
          // what re-renders this row. They are set together so they cannot drift.
          setNotesEnabled(!enabled)
          setEnabled(!enabled)
        }}
      >
        <span className={css.knob} />
      </button>
    </div>
  )
}

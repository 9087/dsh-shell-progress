/**
 * The page's copy of notes it asked for itself.
 *
 * A card's notes are normally written while the command runs, but a command that finishes
 * before the model answers ends up with none persisted — so the card asks for them the first
 * time the reader looks at it (the host's `notes` endpoint). That answer is kept here for as
 * long as the page lives, so collapsing and re-expanding a card, or any re-render, never asks
 * twice.
 *
 * This is the CLIENT half of the cache. The host keeps its own per-command cache (the same
 * command in the same language is never described twice), so a second card of the same
 * command costs neither a model call nor a duplicate sentence; this map only saves the round
 * trip for the SAME card.
 *
 * Nothing here survives a reload: the host's cache does, the request is best-effort, and a
 * note is a convenience that must never make the card wrong or loud about its absence.
 *
 * @module dsh-shell-progress/client/lazy-notes
 */

/** call id → the notes already fetched for it. */
const answers = new Map<string, readonly (string | undefined)[]>()

/** call ids whose request has been made (or is in flight). */
const asked = new Set<string>()

/**
 * Whether this card has already asked for its notes.
 * @param callId - the tool call.
 * @returns true once the request was fired, whether or not it succeeded.
 */
export function notesAsked(callId: string): boolean {
  return asked.has(callId)
}

/**
 * Record that a card asked, BEFORE the answer arrives, so two renders cannot fire two calls.
 * @param callId - the tool call.
 */
export function markNotesAsked(callId: string): void {
  asked.add(callId)
}

/**
 * The notes already fetched for one card.
 * @param callId - the tool call.
 * @returns the notes, or `undefined` when none were fetched.
 */
export function rememberedNotes(callId: string): readonly (string | undefined)[] | undefined {
  return answers.get(callId)
}

/**
 * Keep one card's answer for this page's lifetime.
 * @param callId - the tool call.
 * @param notes - the notes to keep.
 */
export function rememberNotes(callId: string, notes: readonly (string | undefined)[]): void {
  answers.set(callId, notes)
}

/**
 * Forget everything: a reconnected transport belongs to a different host generation, so its
 * answers describe cards that no longer exist there.
 */
export function resetLazyNotes(): void {
  answers.clear()
  asked.clear()
}

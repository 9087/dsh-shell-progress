/**
 * The page's one readable copy of every live call this plugin is watching.
 *
 * Polling is what drives it (there is no host event a standalone plugin can
 * subscribe to), so the store owns the timers and the components own nothing
 * but the framework-bound selector hook. Two identities are load-bearing:
 * the store object itself never changes, and its snapshot reference changes
 * only when the data does — a selector that returned a fresh object on every
 * read would re-render forever.
 *
 * @module dsh-shell-progress/client/store
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { LiveSnapshot } from '../types.ts'
import type { ProgressPort } from './port.ts'

/** Everything the page knows about this plugin's running calls. */
export interface ProgressSnapshot {
  /** Live progress per call id; an absent key means "not watched yet". */
  readonly calls: Readonly<Record<string, LiveSnapshot>>
}

/** The store face: an observable plus the watch registration a card opens. */
export interface ProgressStore extends HostObservable<ProgressSnapshot> {
  /**
   * Keep one call's progress fresh until the returned function runs.
   * @param callId - the tool call to watch.
   * @returns the unwatch function.
   */
  watch(callId: string): () => void
  /** Drop every recorded call and stop polling (used when the transport resets). */
  reset(): void
}

/** Construction options for {@link createProgressStore}. */
export interface ProgressStoreOptions {
  /** Milliseconds between polls of one call. Defaults to 250. */
  readonly intervalMs?: number
}

const DEFAULT_INTERVAL_MS = 250

/**
 * How many consecutive unusable answers end a poll (~30s at the default cadence).
 *
 * The card's own lifetime already bounds this: a settling block re-renders the
 * component and the effect's cleanup unwatches. This cap only stops a timer from
 * outliving a call that never settles AND never appears on the host.
 */
const MAX_MISSES = 120

/** One watched call's polling state. */
interface Watch {
  count: number
  timer: ReturnType<typeof setInterval> | undefined
  inflight: boolean
  misses: number
}

/**
 * Create the store over one port.
 * @param port - the channel port.
 * @param options - polling cadence.
 * @returns the store.
 */
export function createProgressStore(
  port: ProgressPort,
  options: ProgressStoreOptions = {},
): ProgressStore {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const calls = new Map<string, LiveSnapshot>()
  const watches = new Map<string, Watch>()
  const listeners = new Set<() => void>()
  let snapshot: ProgressSnapshot = { calls: {} }

  const publish = (): void => {
    const next: Record<string, LiveSnapshot> = {}
    for (const [callId, value] of calls) next[callId] = value
    snapshot = { calls: next }
    for (const listener of listeners) listener()
  }

  const stop = (callId: string): void => {
    const watch = watches.get(callId)
    if (watch?.timer !== undefined) clearInterval(watch.timer)
    watches.delete(callId)
  }

  const start = (callId: string): void => {
    if (watches.has(callId)) return
    const watch: Watch = { count: 1, timer: undefined, inflight: false, misses: 0 }
    watches.set(callId, watch)
    const tick = async (): Promise<void> => {
      if (watch.inflight) return
      watch.inflight = true
      try {
        const next = await port.snapshot(callId)
        // ONLY a positive answer about THIS call moves the card forward. Three
        // different situations look alike from here and none of them means the
        // command finished:
        //
        //   - the request was refused or failed (no answer at all)
        //   - the value was malformed
        //   - the host has no record of the call YET — and this one is the normal
        //     first tick, because the card is rendered from `tool/call` while the
        //     host registers its record inside `execute`, a moment later
        //
        // Treating any of them as "settled" stopped the poll on that first tick,
        // which froze the bar at its starting shape and let it jump only when the
        // result landed.
        if (next === undefined || !next.found) {
          watch.misses += 1
          publish()
          if (watch.misses > MAX_MISSES) stop(callId)
          return
        }
        watch.misses = 0
        calls.set(callId, next)
        publish()
        // Now the host HAS spoken about this call: a settled answer ends the poll,
        // because the card switches to its persisted metadata and this timer has
        // nothing left to say.
        if (!next.running) stop(callId)
      } catch {
        // A thrown poll keeps the last snapshot and tries again on the next tick;
        // a card must never blink out because one request failed.
        watch.misses += 1
        publish()
        if (watch.misses > MAX_MISSES) stop(callId)
      } finally {
        watch.inflight = false
      }
    }
    void tick()
    watch.timer = setInterval(() => { void tick() }, intervalMs)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    watch(callId) {
      const existing = watches.get(callId)
      if (existing !== undefined) existing.count += 1
      else start(callId)
      let open = true
      return () => {
        if (!open) return
        open = false
        const watch = watches.get(callId)
        if (watch === undefined) return
        watch.count -= 1
        if (watch.count <= 0) stop(callId)
      }
    },
    reset() {
      for (const callId of [...watches.keys()]) stop(callId)
      if (calls.size > 0) {
        calls.clear()
        publish()
      }
    },
  }
}

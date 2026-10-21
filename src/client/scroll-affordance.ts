/**
 * Scroll affordances for a card whose step list is taller than the box that shows it.
 *
 * The card itself never scrolls: `.card` is a clipping box and `.steps` deliberately has no
 * overflow, so the reader's wheel drives whichever ANCESTOR scrolls — and which ancestor that
 * is depends on the shell's state. Measured on this host, in a real browser:
 *
 * - a turn that has ended folds into its process box (`O_Ebla_body`, `max-height:
 *   min(400px, 50vh)`, `overflow-y: auto`), which scrolls the turn's tool calls;
 * - the whole conversation scrolls in the page-level scroller (`wSkVaW_scrollBody`, the
 *   element carrying `data-conversation-scroll`), and the chat column's own scroller is
 *   deliberately `overflow: visible` in that mode so there is never a second scrollbar.
 *
 * So the rule is "the nearest ancestor that can ACTUALLY scroll" — never a hard-coded
 * selector. A container that cannot scroll right now is SKIPPED rather than trusted: the
 * folded turn's process box is `overflow-y: auto` with a height of 0, and measuring edges
 * against a zero-height viewport would enable both buttons on a card nobody can see.
 *
 * @module dsh-shell-progress/client/scroll-affordance
 */

/** Which edges of the card are outside its scroll container's visible box. */
export interface ClippedEdges {
  /** The card's own top edge sits above the container's viewport. */
  readonly top: boolean
  /** The step list's bottom edge sits below the container's viewport. */
  readonly bottom: boolean
}

/** A computed `overflow-y` that makes a box a scroll container. */
const SCROLLABLE = /^(?:auto|scroll)$/u

/**
 * The nearest ancestor that can scroll the card, or the document's own scroller.
 * @param card - the card's root element.
 * @returns the scroll container, or undefined when nothing can scroll it.
 */
export function scrollContainerOf(card: HTMLElement): HTMLElement | undefined {
  for (let element = card.parentElement; element !== null; element = element.parentElement) {
    if (!SCROLLABLE.test(getComputedStyle(element).overflowY)) continue
    // `clientHeight === 0` is a COLLAPSED box (a folded turn's process body), not a viewport.
    if (element.clientHeight <= 0) continue
    if (element.scrollHeight <= element.clientHeight + 1) continue
    return element
  }
  const scroller = card.ownerDocument.scrollingElement
  return scroller instanceof HTMLElement ? scroller : undefined
}

/**
 * Which of the card's two edges are outside the visible box right now.
 * @param card - the card's root element.
 * @param list - the step list's own box (its bottom edge is the lower one).
 * @returns the clipped edges; both false when nothing scrolls.
 */
export function clippedEdges(card: HTMLElement, list: HTMLElement): ClippedEdges {
  const container = scrollContainerOf(card)
  if (container === undefined) return { top: false, bottom: false }
  const viewport = container.getBoundingClientRect()
  return {
    top: card.getBoundingClientRect().top < viewport.top - 1,
    bottom: list.getBoundingClientRect().bottom > viewport.top + container.clientHeight + 1,
  }
}

/**
 * Bring the card's own top edge to the top of its scroll container.
 * @param card - the card's root element.
 */
export function scrollCardToTop(card: HTMLElement): void {
  const container = scrollContainerOf(card)
  if (container === undefined) return
  const viewport = container.getBoundingClientRect()
  const delta = card.getBoundingClientRect().top - viewport.top - scrollPadding(container, 'Top')
  scrollWithin(container, delta)
}

/**
 * Bring the step list's bottom edge to the bottom of its scroll container.
 * @param card - the card's root element.
 * @param list - the step list's own box.
 */
export function scrollListToBottom(card: HTMLElement, list: HTMLElement): void {
  const container = scrollContainerOf(card)
  if (container === undefined) return
  const viewport = container.getBoundingClientRect()
  const delta = list.getBoundingClientRect().bottom - (viewport.top + container.clientHeight) + scrollPadding(container, 'Bottom')
  scrollWithin(container, delta)
}

/**
 * The container's own `scroll-padding-*`, so a scroll lands where the CSS asked rather than
 * hard against the edge.
 * @param container - the scroll container.
 * @param side - which side's padding to read.
 * @returns the padding in pixels, 0 when it is not a number.
 */
function scrollPadding(container: HTMLElement, side: 'Top' | 'Bottom'): number {
  const style = getComputedStyle(container)
  const value = Number.parseFloat(side === 'Top' ? style.scrollPaddingTop : style.scrollPaddingBottom)
  return Number.isFinite(value) ? value : 0
}

/**
 * Scroll one container by a delta, clamped to its own range.
 * @param container - the scroll container.
 * @param delta - pixels to add to `scrollTop`.
 */
function scrollWithin(container: HTMLElement, delta: number): void {
  const max = Math.max(0, container.scrollHeight - container.clientHeight)
  const next = Math.min(max, Math.max(0, container.scrollTop + delta))
  container.scrollTo({ top: next })
}

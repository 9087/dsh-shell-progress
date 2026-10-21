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
  const visibleBottom = viewport.top + container.clientHeight - composerOcclusion(container)
  return {
    top: card.getBoundingClientRect().top < viewport.top - 1,
    bottom: list.getBoundingClientRect().bottom > visibleBottom + 1,
  }
}

/**
 * How many pixels of the scrollport's BOTTOM edge the composer covers.
 *
 * The shell's composer is a `position: sticky` seat at the foot of the conversation, and it is
 * 128px tall on this host: the scroll body extends to the window's bottom edge BEHIND it, so
 * "scroll to the bottom" without this correction leaves the list's last rows behind the input
 * box — the reader scrolls as far as the bar allows and still cannot see the end. Measured:
 * the seat's box is `[data-composer-seat]` with `data-conversation-region="composer"`, a
 * semantic marker rather than a hashed class name.
 *
 * A seat is counted only when it actually covers THIS scroller: its box has to overlap the
 * scroller horizontally and start above the scroller's bottom edge. A seat below the scroller
 * (or a second pane's seat elsewhere) contributes nothing.
 *
 * @param container - the scroll container.
 * @returns the covered height in pixels, 0 when nothing covers the box.
 */
export function composerOcclusion(container: HTMLElement): number {
  const viewport = container.getBoundingClientRect()
  const bottom = viewport.top + container.clientHeight
  let occlusion = 0
  for (const seat of container.ownerDocument.querySelectorAll('[data-composer-seat]')) {
    const rect = seat.getBoundingClientRect()
    if (rect.height <= 0) continue
    if (rect.right <= viewport.left || rect.left >= viewport.right) continue
    if (rect.top >= bottom - 1) continue
    occlusion = Math.max(occlusion, bottom - Math.max(rect.top, viewport.top))
  }
  return occlusion
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
 * Bring the step list's bottom edge to the bottom of its scroll container — above the
 * composer, not behind it.
 * @param card - the card's root element.
 * @param list - the step list's own box.
 */
export function scrollListToBottom(card: HTMLElement, list: HTMLElement): void {
  const container = scrollContainerOf(card)
  if (container === undefined) return
  const viewport = container.getBoundingClientRect()
  const visibleBottom = viewport.top + container.clientHeight - composerOcclusion(container)
  const delta = list.getBoundingClientRect().bottom - visibleBottom + scrollPadding(container, 'Bottom') + BOTTOM_GAP
  scrollWithin(container, delta)
}

/** Breathing room between the list's last row and whatever bounds the visible box. */
const BOTTOM_GAP = 8

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

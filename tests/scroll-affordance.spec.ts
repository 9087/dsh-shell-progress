/**
 * The scroll strip's geometry, with a stubbed layout.
 *
 * jsdom has no layout, so this file measures the MATH and the e2e measures the pixels: each
 * element's box is handed to the module directly, which is exactly the input the module reads
 * from `getBoundingClientRect()` in a browser. The case worth pinning here is the composer:
 * the shell renders it as a sticky 128px seat over the BOTTOM of the page scroller, so a
 * "scroll to the bottom" that stops at the scrollport's edge leaves the list's last rows
 * behind the input box (the reader reported exactly that).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clippedEdges, composerOcclusion, scrollListToBottom } from '../src/client/scroll-affordance.ts'

/** One element's box, in viewport coordinates. */
interface Box {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

/**
 * Build a box from its top and bottom edges.
 * @param top - the top edge, in viewport pixels.
 * @param bottom - the bottom edge, in viewport pixels.
 * @returns the box.
 */
function box(top: number, bottom: number): Box {
  return { top, bottom, left: 100, right: 1200 }
}

/**
 * Hand one element a rect, the way the browser would.
 * @param element - the element.
 * @param rect - its box.
 */
function withRect(element: HTMLElement, rect: Box): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    toJSON: () => ({}),
  } as DOMRect)
}

/**
 * Hand one element a scroll box, the way the browser would.
 * @param element - the element.
 * @param size - the box's `clientHeight` and `scrollHeight`.
 * @returns the `scrollTo` spy.
 */
function withScrollBox(
  element: HTMLElement,
  size: { clientHeight: number, scrollHeight: number },
): ReturnType<typeof vi.fn> {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: size.clientHeight })
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: size.scrollHeight })
  Object.defineProperty(element, 'scrollTop', { configurable: true, writable: true, value: 500 })
  const scrollTo = vi.fn()
  Object.defineProperty(element, 'scrollTo', { configurable: true, value: scrollTo })
  return scrollTo
}

/** The test page: a scroller holding a card holding a list, plus the composer's seat. */
interface Page {
  readonly scroller: HTMLElement
  readonly card: HTMLElement
  readonly list: HTMLElement
  readonly seat: HTMLElement
  readonly scrollTo: ReturnType<typeof vi.fn>
}

/** Build the page with the geometry a 1400x900 window has on this host. */
function page(): Page {
  document.body.innerHTML = ''
  const scroller = document.createElement('div')
  scroller.style.overflowY = 'auto'
  const card = document.createElement('div')
  const list = document.createElement('div')
  card.append(list)
  scroller.append(card)
  document.body.append(scroller)
  const seat = document.createElement('div')
  seat.setAttribute('data-composer-seat', '')
  document.body.append(seat)
  // The scrollport runs from the header (76px) to the window's bottom (900px): 824px of window.
  withRect(scroller, box(76, 900))
  const scrollTo = withScrollBox(scroller, { clientHeight: 824, scrollHeight: 2000 })
  // The card is taller than the scrollport and starts above it, so BOTH of its edges are out.
  withRect(card, box(40, 1200))
  // The composer's seat: the bottom 128px of the scrollport, sticking over the content.
  withRect(seat, box(772, 900))
  return { scroller, card, list, seat, scrollTo }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('composerOcclusion', () => {
  it('reports the seat height that covers the scrollport', () => {
    const { scroller } = page()
    expect(composerOcclusion(scroller)).toBe(128)
  })

  it('ignores a seat that sits below the scrollport', () => {
    const { scroller, seat } = page()
    withRect(seat, box(900, 1000))
    expect(composerOcclusion(scroller)).toBe(0)
  })

  it('ignores a seat that does not overlap the scrollport horizontally', () => {
    const { scroller, seat } = page()
    vi.spyOn(seat, 'getBoundingClientRect').mockReturnValue({
      ...box(772, 900),
      left: 1300,
      right: 1400,
      x: 1300,
      y: 772,
      width: 100,
      height: 128,
      toJSON: () => ({}),
    } as DOMRect)
    expect(composerOcclusion(scroller)).toBe(0)
  })
})

describe('clippedEdges', () => {
  it('counts a list hidden behind the composer as clipped', () => {
    const { card, list } = page()
    // 78px of the list sit behind the composer, but it is INSIDE the scrollport (bottom 850 of
    // 900): without the composer correction this card would claim to be fully visible.
    withRect(list, box(300, 850))
    expect(clippedEdges(card, list)).toEqual({ top: true, bottom: true })
  })

  it('does not count a list that fits above the composer', () => {
    const { card, list } = page()
    withRect(list, box(300, 760))
    expect(clippedEdges(card, list)).toEqual({ top: true, bottom: false })
  })
})

describe('scrollListToBottom', () => {
  it('lands the list above the composer, not at the scrollport edge', () => {
    const { card, list, scroller } = page()
    withRect(list, box(300, 850))
    scrollListToBottom(card, list)
    // 500 (current) + (850 - 772 visible bottom) + 8px gap = 586.
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 586 })
  })

  it('uses the scrollport edge when no composer covers it', () => {
    const { card, list, scroller, seat } = page()
    seat.remove()
    withRect(list, box(300, 850))
    scrollListToBottom(card, list)
    // 500 + (850 - 900) + 8 = 458.
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 458 })
  })
})

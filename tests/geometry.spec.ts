import { describe, expect, it } from 'vitest'
import { MIN_SEGMENT_DEVICE_PX, segmentGeometry, type TrackGeometry } from '../src/client/geometry.ts'

/** The widths back in DEVICE pixels, which is the space the rules are written in. */
function deviceWidths(geometry: TrackGeometry, ratio: number): number[] {
  return geometry.widths.map((width) => Number.parseFloat(width) * ratio)
}

/** What the segments plus their seams add up to, in device pixels. */
function totalDevice(geometry: TrackGeometry, ratio: number): number {
  const widths = deviceWidths(geometry, ratio)
  const gap = Number.parseFloat(geometry.gap) * ratio
  return widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1)
}

describe('segmentGeometry', () => {
  it('splits a track into whole device pixels with one-pixel seams', () => {
    const geometry = segmentGeometry(663, 4, 1)
    expect(geometry.gap).toBe('1px')
    expect(deviceWidths(geometry, 1)).toEqual([165, 165, 165, 165])
    expect(totalDevice(geometry, 1)).toBe(663)
  })

  it('spreads the remainder over the first segments', () => {
    // 663 - 6 seams = 657; 657 / 7 = 93 with 6 left over, so the first six take the
    // extra pixel and the seventh does not.
    const geometry = segmentGeometry(663, 7, 1)
    expect(deviceWidths(geometry, 1)).toEqual([94, 94, 94, 94, 94, 94, 93])
    expect(totalDevice(geometry, 1)).toBe(663)
  })

  it('keeps the arithmetic whole at a fractional device ratio', () => {
    // 125% scaling: 662.703125 CSS px is 828 device px.
    const geometry = segmentGeometry(828, 4, 1.25)
    expect(geometry.gap).toBe('0.8px')
    expect(deviceWidths(geometry, 1.25).map((width) => Math.round(width))).toEqual([207, 206, 206, 206])
    expect(totalDevice(geometry, 1.25)).toBeCloseTo(828, 6)
  })

  it('makes every segment a whole number of device pixels at any ratio', () => {
    for (const ratio of [1, 1.25, 1.5, 2]) {
      for (const count of [1, 2, 3, 4, 11, 40]) {
        const geometry = segmentGeometry(703, count, ratio)
        for (const width of deviceWidths(geometry, ratio)) {
          expect(Math.abs(width - Math.round(width)), `ratio ${String(ratio)} count ${String(count)}`).toBeLessThan(0.02)
        }
        expect(totalDevice(geometry, ratio), `ratio ${String(ratio)} count ${String(count)}`).toBeCloseTo(703, 4)
      }
    }
  })

  it('drops the seams rather than spend the bar on them', () => {
    // 400 steps in a 663px bar: one device pixel per seam would be 399 seams and no bar.
    const geometry = segmentGeometry(663, 400, 1)
    expect(geometry.gap).toBe('0px')
    const widths = deviceWidths(geometry, 1)
    expect(widths).toHaveLength(400)
    expect(Math.min(...widths), 'a segment vanished').toBeGreaterThanOrEqual(1)
    expect(totalDevice(geometry, 1)).toBe(663)
  })

  it('drops the seams exactly at the segment floor', () => {
    // Exactly the floor: seams still fit.
    expect(segmentGeometry(4 * MIN_SEGMENT_DEVICE_PX, 4, 1).gap).toBe('1px')
    // One device pixel narrower and they do not.
    expect(segmentGeometry(4 * MIN_SEGMENT_DEVICE_PX - 1, 4, 1).gap).toBe('0px')
  })

  it('gives equal fractions when the track cannot hold a pixel per step', () => {
    const geometry = segmentGeometry(2, 4, 1)
    expect(geometry.gap).toBe('0px')
    expect(geometry.widths).toEqual(['0.5px', '0.5px', '0.5px', '0.5px'])
    expect(totalDevice(geometry, 1)).toBeCloseTo(2, 6)
  })

  it('gives a single step the whole width and no seam', () => {
    const geometry = segmentGeometry(100, 1, 1)
    expect(geometry.gap).toBe('0px')
    expect(geometry.widths).toEqual(['100px'])
  })

  it('has nothing to lay out for an empty or unmeasured bar', () => {
    expect(segmentGeometry(0, 4, 1).widths).toEqual([])
    expect(segmentGeometry(663, 0, 1).widths).toEqual([])
  })
})

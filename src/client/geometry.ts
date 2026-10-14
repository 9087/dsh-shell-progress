/**
 * Device-pixel geometry for the segmented progress bar.
 *
 * Kept apart from the component and free of DOM access, because the arithmetic is
 * where the pixel rules live and the interesting cases — a track narrower than its own
 * seams — are exactly the ones a browser window cannot easily be put into.
 *
 * @module dsh-shell-progress/client/geometry
 */

/** The separator between two segments, in DEVICE pixels. */
export const SEAM_DEVICE_PX = 1

/**
 * Below this many DEVICE pixels per segment, the seams are dropped entirely.
 *
 * A bar with enough steps otherwise spends more of itself on separators than on
 * segments: at one device pixel per seam, 400 steps would be 399 seams and no bar left
 * to show. So once a segment would come out thinner than this, the separators go and
 * the segments share the whole width.
 */
export const MIN_SEGMENT_DEVICE_PX = 2

/** Resolved geometry, in CSS pixels and ready to become inline styles. */
export interface TrackGeometry {
  /** The gap between segments; `0px` when the seams were dropped. */
  readonly gap: string
  /** One width per step, in the order the steps render. */
  readonly widths: readonly string[]
}

/**
 * Split `deviceWidth` device pixels into `count` segments.
 *
 * Whole device pixels per segment, with the remainder spread over the FIRST few, so the
 * widths add up to the track exactly and nothing is left for the browser to round.
 *
 * The seam is one device pixel, with two exceptions, both about a bar too small to
 * afford one:
 *
 * - A segment thinner than `MIN_SEGMENT_DEVICE_PX` gets no seam at all — see above.
 * - A track that cannot give every step even one device pixel gets equal fractions and
 *   no seam, because a strip of equal fractions still reads as a bar while a row of
 *   zero-width segments reads as nothing.
 */
export function segmentGeometry(deviceWidth: number, count: number, ratio: number): TrackGeometry {
  if (count <= 0 || deviceWidth <= 0) return { gap: '0px', widths: [] }

  // A single segment has nothing to separate, so it reports no seam either.
  const seam = count > 1 && deviceWidth / count >= MIN_SEGMENT_DEVICE_PX ? SEAM_DEVICE_PX : 0
  const usable = deviceWidth - (count - 1) * seam
  const base = Math.floor(usable / count)

  if (base < 1) {
    const width = `${String(deviceWidth / count / ratio)}px`
    return { gap: '0px', widths: Array.from({ length: count }, () => width) }
  }

  const extra = usable - base * count
  return {
    gap: `${String(seam / ratio)}px`,
    widths: Array.from({ length: count }, (_unused, index) =>
      `${String((base + (index < extra ? 1 : 0)) / ratio)}px`),
  }
}

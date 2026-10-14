import { describe, expect, it } from 'vitest'
import { createNonce, markerText } from '../src/instrument.ts'
import { LineFeeder } from '../src/parse.ts'

const NONCE = 'abcdef01'
const marker = (line: number): string => markerText(NONCE, line)

describe('LineFeeder', () => {
  it('separates marker lines from output lines', () => {
    const feeder = new LineFeeder(NONCE)
    expect(feeder.feed(`${marker(2)}\nhello\n`)).toEqual([
      { kind: 'marker', line: 2 },
      { kind: 'text', text: 'hello' },
    ])
  })

  it('holds a marker split across two reads back until it is whole', () => {
    const feeder = new LineFeeder(NONCE)
    expect(feeder.feed('__DSH_STEP_ab')).toEqual([])
    expect(feeder.feed('cdef01_9__\n')).toEqual([{ kind: 'marker', line: 9 }])
  })

  it('holds a partial output line back until it is complete', () => {
    const feeder = new LineFeeder(NONCE)
    expect(feeder.feed('par')).toEqual([])
    expect(feeder.feed('tial\n')).toEqual([{ kind: 'text', text: 'partial' }])
  })

  it('never treats another nonce as a marker', () => {
    const feeder = new LineFeeder(NONCE)
    expect(feeder.feed('__DSH_STEP_ffffffff_1__\n')).toEqual([
      { kind: 'text', text: '__DSH_STEP_ffffffff_1__' },
    ])
  })

  it('never treats a marker with extra text as a marker', () => {
    const feeder = new LineFeeder(NONCE)
    expect(feeder.feed(` ${marker(1)}\n`)).toEqual([{ kind: 'text', text: ` ${marker(1)}` }])
  })

  it('strips the carriage return of a CRLF stream', () => {
    const feeder = new LineFeeder(NONCE)
    expect(feeder.feed('line\r\n')).toEqual([{ kind: 'text', text: 'line' }])
  })

  it('emits the trailing fragment only on flush', () => {
    const feeder = new LineFeeder(NONCE)
    expect(feeder.feed('tail without newline')).toEqual([])
    expect(feeder.flush()).toEqual([{ kind: 'text', text: 'tail without newline' }])
    expect(feeder.flush()).toEqual([])
  })

  it('emits nothing for an empty delta', () => {
    expect(new LineFeeder(NONCE).feed('')).toEqual([])
  })

  it('keeps an empty line as an output line', () => {
    expect(new LineFeeder(NONCE).feed('\n')).toEqual([{ kind: 'text', text: '' }])
  })

  it('handles a marker as the very last line without a terminator', () => {
    const feeder = new LineFeeder(NONCE)
    expect(feeder.feed(marker(4))).toEqual([])
    expect(feeder.flush()).toEqual([{ kind: 'marker', line: 4 }])
  })

  it('accepts a real nonce shape', () => {
    const nonce = createNonce()
    const feeder = new LineFeeder(nonce)
    expect(feeder.feed(`${markerText(nonce, 5)}\n`)).toEqual([{ kind: 'marker', line: 5 }])
  })
})

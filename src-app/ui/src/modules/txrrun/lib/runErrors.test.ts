/**
 * txrrun — the create-path error resolution pins (ITEM-8; CONS-UI-RUN-7,
 * DEC-18): `staleMethodIds` attributes a 404 to the method it names, the
 * notice is never blank, and the no-attribution case is the error line's
 * job (never a silent drop).
 */
import { describe, expect, it } from 'vitest'
import {
  droppedNotice,
  RUN_ALREADY_ACTIVE_LINE,
  RUN_METHODS_GONE_LINE,
  staleMethodIds,
} from './runErrors'

describe('runErrors (ITEM-8)', () => {
  it('attributes the 404 to the id the engine message names (the provider bytes)', () => {
    const dropped = staleMethodIds(
      'no method "direct-on" in the shipped catalogue',
      ['direct-on', 'dynforest'],
      ['direct-on', 'dynforest'],
    )
    expect(dropped).toEqual(['direct-on'])
  })

  it('uses the local catalogue when the 404 message names no id', () => {
    expect(staleMethodIds('METHOD_NOT_FOUND', ['direct-on'], ['dynforest'])).toEqual([
      'direct-on',
    ])
  })

  it('a message naming an id outside the selection drops nothing (no silent guess)', () => {
    expect(staleMethodIds('no method "other" in the shipped catalogue', ['direct-on'], [
      'direct-on',
    ])).toEqual([])
  })

  it('a known list that never answered attributes nothing — no "everything dropped"', () => {
    expect(staleMethodIds('METHOD_NOT_FOUND', ['direct-on'], [])).toEqual([])
  })

  it('the dropped-rows notice names the dropped method / count — never blank', () => {
    expect(droppedNotice(['direct-on'])).toBe(
      'direct-on is no longer in the method catalogue — it was removed from the selection.',
    )
    expect(droppedNotice(['direct-on', 'dynforest'])).toBe(
      '2 methods are no longer in the method catalogue — they were removed from the selection.',
    )
    expect(RUN_ALREADY_ACTIVE_LINE).not.toBe('')
    expect(RUN_METHODS_GONE_LINE).not.toBe('')
  })
})

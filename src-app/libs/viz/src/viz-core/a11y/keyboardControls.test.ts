// keyboardControls.test.ts — L0 unit tests for the pure key→action mapper (node env).

import { describe, it, expect } from 'vitest'
import { keyToAction, PAN_STEP, PAN_STEP_LARGE } from './keyboardControls'

describe('keyToAction', () => {
  it('maps arrows to pan intents in the arrow direction', () => {
    expect(keyToAction('ArrowLeft')).toEqual({ type: 'pan', dx: -PAN_STEP, dy: 0 })
    expect(keyToAction('ArrowRight')).toEqual({ type: 'pan', dx: PAN_STEP, dy: 0 })
    expect(keyToAction('ArrowUp')).toEqual({ type: 'pan', dx: 0, dy: PAN_STEP })
    expect(keyToAction('ArrowDown')).toEqual({ type: 'pan', dx: 0, dy: -PAN_STEP })
  })

  it('uses the larger step when Shift is held', () => {
    expect(keyToAction('ArrowRight', { shift: true })).toEqual({
      type: 'pan',
      dx: PAN_STEP_LARGE,
      dy: 0,
    })
    expect(keyToAction('ArrowUp', { shift: true })).toEqual({
      type: 'pan',
      dx: 0,
      dy: PAN_STEP_LARGE,
    })
    expect(PAN_STEP_LARGE).toBeGreaterThan(PAN_STEP)
  })

  it('maps +/= to zoom in and -/_ to zoom out', () => {
    expect(keyToAction('+')).toEqual({ type: 'zoom', dir: 'in' })
    expect(keyToAction('=')).toEqual({ type: 'zoom', dir: 'in' })
    expect(keyToAction('-')).toEqual({ type: 'zoom', dir: 'out' })
    expect(keyToAction('_')).toEqual({ type: 'zoom', dir: 'out' })
  })

  it('maps Escape to clearSelection', () => {
    expect(keyToAction('Escape')).toEqual({ type: 'clearSelection' })
  })

  it('maps Enter and Space to activate', () => {
    expect(keyToAction('Enter')).toEqual({ type: 'activate' })
    expect(keyToAction(' ')).toEqual({ type: 'activate' })
    expect(keyToAction('Spacebar')).toEqual({ type: 'activate' })
  })

  it('returns null for unhandled keys', () => {
    for (const k of ['a', 'Tab', 'Shift', 'F5', 'Home', '1']) {
      expect(keyToAction(k)).toBeNull()
    }
  })

  it('Shift does not affect non-pan keys', () => {
    expect(keyToAction('+', { shift: true })).toEqual({ type: 'zoom', dir: 'in' })
    expect(keyToAction('Escape', { shift: true })).toEqual({ type: 'clearSelection' })
  })
})

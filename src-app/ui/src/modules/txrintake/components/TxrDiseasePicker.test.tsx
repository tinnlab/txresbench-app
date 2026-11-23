// @vitest-environment jsdom
/**
 * study-step-ui-tweaks — `components/TxrDiseasePicker.tsx`: the disease box
 * takes the full width of the filters column. The picker's wrapper carries
 * the full-width style (and `minWidth: 0`), and the kit's trigger fills it
 * (`w-full`), with the open list anchored to the trigger's width — so the
 * box is full width at every window width.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TxrDiseasePicker } from './TxrDiseasePicker'

afterEach(() => {
  cleanup()
})

describe('TxrDiseasePicker (study-step-ui-tweaks — the full-width box)', () => {
  it('the trigger takes the full width of the filters column (wrapper style check)', () => {
    render(<TxrDiseasePicker value={null} categories={[]} onChange={() => undefined} />)
    const trigger = screen.getByTestId('txr-intake-study-disease')
    const wrapper = screen.getByTestId('txr-intake-study-disease-wrap')
    // The wrapper spans the column and never lets its content size it down.
    expect(wrapper.style.width).toBe('100%')
    expect(['0', '0px']).toContain(wrapper.style.minWidth)
    // The trigger itself fills the wrapper (the kit trigger's w-full rule),
    // and the open list is anchored to the trigger's width.
    expect(trigger.className).toContain('w-full')
    expect(wrapper.contains(trigger)).toBe(true)
  })
})

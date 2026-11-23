// @vitest-environment jsdom
/**
 * study-step-ui-tweaks — `components/TxrExcludedSections.tsx`: the group
 * headings sit inside the indented container (16 px, under the "N methods
 * are left out" heading), and each heading trigger carries a chevron before
 * its text whose `data-state` follows the trigger's `aria-expanded` — closed
 * → open after a click — and turns down (rotate 90deg) when expanded.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TxrExcludedSections } from './TxrExcludedSections'
import type { ExcludedMethod } from '../lib/preview'

afterEach(() => {
  cleanup()
})

const EXCLUDED: ExcludedMethod[] = [
  {
    id: 'method-a',
    reasonText: 'Made for melanoma, not your disease',
    reasonCode: 'DISEASE_NOT_MATCHED',
  },
  {
    id: 'method-b',
    reasonText: 'Made for Chemotherapy, not your treatments',
    reasonCode: 'TREATMENT_NOT_MATCHED',
  },
  {
    id: 'method-c',
    reasonText: 'needs 3 or more draws',
    reasonCode: 'MIN_DRAWS_UNMET',
  },
]

describe('TxrExcludedSections (study-step-ui-tweaks — the indented headings and chevrons)', () => {
  it('the headings sit inside the indented container', () => {
    render(<TxrExcludedSections excluded={EXCLUDED} limit={2} />)
    const groups = screen.getByTestId('txr-intake-excluded-groups')
    expect(groups.style.paddingLeft).toBe('16px')
    for (const key of ['disease', 'treatment', 'other']) {
      const heading = screen.getByTestId(`txr-intake-excluded-section-${key}`)
      expect(groups.contains(heading)).toBe(true)
    }
  })

  it('every heading carries a chevron in both states; the data attribute follows aria-expanded', () => {
    render(<TxrExcludedSections excluded={EXCLUDED} limit={2} />)
    for (const key of ['disease', 'treatment', 'other']) {
      const heading = screen.getByTestId(`txr-intake-excluded-section-${key}`)
      const chevron = heading.querySelector('svg[data-state]') as SVGSVGElement | null
      expect(chevron, `the ${key} heading has a chevron`).toBeTruthy()
      expect(chevron!.getAttribute('aria-hidden')).toBe('true')
      expect(chevron!.getAttribute('data-state')).toBe('closed')
      expect(heading.getAttribute('aria-expanded')).toBe('false')
      expect(chevron!.style.transition).toContain('transform 150ms')
    }
    // Open one section: the trigger's aria-expanded and the chevron flip
    // together, and the chevron turns down.
    const heading = screen.getByTestId('txr-intake-excluded-section-disease')
    const chevron = heading.querySelector('svg[data-state]') as SVGSVGElement
    fireEvent.click(heading)
    expect(heading.getAttribute('aria-expanded')).toBe('true')
    const openChevron = screen
      .getByTestId('txr-intake-excluded-section-disease')
      .querySelector('svg[data-state]') as SVGSVGElement
    expect(openChevron.getAttribute('data-state')).toBe('open')
    expect(openChevron.style.transform).toBe('rotate(90deg)')
    // Close it again: the chevron follows back.
    fireEvent.click(screen.getByTestId('txr-intake-excluded-section-disease'))
    expect(
      screen
        .getByTestId('txr-intake-excluded-section-disease')
        .getAttribute('aria-expanded'),
    ).toBe('false')
    expect(
      screen
        .getByTestId('txr-intake-excluded-section-disease')
        .querySelector('svg[data-state]')!
        .getAttribute('data-state'),
    ).toBe('closed')
  })
})

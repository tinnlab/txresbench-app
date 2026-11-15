// @vitest-environment jsdom
/**
 * TEST-DM-5 (example-card half) — ExampleFileCard (ITEM-5): the demo-only
 * example table card (title per kind, the "Example" badge, the real facts
 * line — rows + markers — and the optional download affordance); null in
 * desktop and while the boot read is pending.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ExampleFileCard } from './ExampleFileCard'
import { resetDemoMode, seedDemoMode } from '../test-utils/demoSeed'

beforeEach(() => resetDemoMode())
afterEach(() => cleanup())

describe('ExampleFileCard (ITEM-5)', () => {
  it('demo mode: the patients card renders the title, the badge, the real facts and the download', () => {
    seedDemoMode('demo')
    const onDownloadExample = vi.fn()
    render(<ExampleFileCard kind="patients" rows={94} onDownloadExample={onDownloadExample} />)
    expect(screen.getByTestId('txr-example-card-patients').textContent).toContain('Example patients')
    expect(screen.getByTestId('txr-example-card-badge-patients').textContent).toBe('Example')
    expect(screen.getByTestId('txr-example-card-facts-patients').textContent).toBe('94 rows')
    fireEvent.click(screen.getByTestId('txr-example-card-download-patients'))
    expect(onDownloadExample).toHaveBeenCalledTimes(1)
  })

  it('demo mode: the measurements card shows the marker facts', () => {
    seedDemoMode('demo')
    render(<ExampleFileCard kind="measurements" rows={630} markers={['LDH', 'CRP']} />)
    expect(screen.getByTestId('txr-example-card-measurements').textContent).toContain('Example measurements')
    expect(screen.getByTestId('txr-example-card-facts-measurements').textContent).toBe(
      '630 rows · 2 markers: LDH, CRP',
    )
  })

  it('desktop mode: nothing renders (the cards are demo-only)', () => {
    seedDemoMode('desktop')
    const { container } = render(<ExampleFileCard kind="patients" rows={94} />)
    expect(container.textContent).toBe('')
  })

  it('pending mode: nothing renders (no flash)', () => {
    const { container } = render(<ExampleFileCard kind="patients" rows={94} />)
    expect(container.textContent).toBe('')
  })
})

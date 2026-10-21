// @vitest-environment jsdom
//
// The attach-picker OPTION as it is actually rendered.
//
// The point of this file is one distinction the pure tests cannot make: "listed" and
// "marked" are different claims, and until this change the picker satisfied the first
// while failing the second. A test that asserted only that a broken dataset appears in
// the option list passed on the code this fixes.

import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { buildAttachOption } from './attachOptionRow'
import type { AttachCandidate } from './attachOptions'

beforeEach(() => {
  cleanup()
})

const candidate = (over: Partial<AttachCandidate> = {}): AttachCandidate => ({
  id: 'd1',
  name: 'Donor A',
  datatype: 'probe/matrix',
  source: 'owned',
  ...over,
})

/** Render just the option's LABEL — the node the kit puts in the dropdown row. */
function renderOption(c: AttachCandidate, holdings: { text: string; detail: string } | null = null) {
  const opt = buildAttachOption(c, { typeLabel: 'Probe matrix', holdings })
  render(<>{opt.label}</>)
  return opt
}

describe('the attach option row', () => {
  it('a FAILED dataset is listed AND MARKED, with the reason reachable', () => {
    const c = candidate({
      processingStatus: 'failed',
      processingError: 'converter exited 2',
    })
    renderOption(c)
    // listed: the name is on screen …
    expect(screen.getByText('Donor A')).toBeTruthy()
    // … and MARKED: a status badge sits beside it.
    const marker = screen.getByTestId(`project-attach-opt-status-${c.id}`)
    expect(marker.textContent).toMatch(/failed/i)
    // The reason is not hover-only — it is in the badge's accessible name.
    const badge = screen.getByTestId('dataset-processing-status')
    expect(badge.getAttribute('aria-label')).toContain('converter exited 2')
    expect(badge.getAttribute('title')).toBe('converter exited 2')
  })

  it('an in-flight dataset is marked as PROCESSING, not as failed', () => {
    renderOption(candidate({ processingStatus: 'running' }))
    const marker = screen.getByTestId('project-attach-opt-status-d1')
    expect(marker.textContent).toMatch(/processing/i)
    expect(marker.textContent).not.toMatch(/failed/i)
  })

  it('a READY dataset carries no marker at all (the badge is not always-on)', () => {
    // NEGATIVE CONTROL for the two above: if the marker rendered unconditionally,
    // "is marked" would be true of every row and would mean nothing.
    renderOption(candidate({ processingStatus: 'completed' }))
    expect(screen.queryByTestId('project-attach-opt-status-d1')).toBeNull()
    cleanup()
    renderOption(candidate()) // no processing job at all
    expect(screen.queryByTestId('project-attach-opt-status-d1')).toBeNull()
  })

  it('shows what the dataset holds, with the fuller form as the hover text', () => {
    // The row renders the composed line VERBATIM and puts `detail` on the hover — it
    // composes nothing of its own, which is why this fixture is an opaque string.
    renderOption(candidate(), {
      text: '120 rows x 36 spans · 63 probe columns',
      detail: '120 rows x 36 spans · 63 probe columns · 2.0 KB',
    })
    const line = screen.getByTestId('project-attach-opt-holdings-d1')
    expect(line.textContent).toBe('120 rows x 36 spans · 63 probe columns')
    expect(line.getAttribute('title')).toContain('2.0 KB')
  })

  it('says NOTHING about holdings when the summary is unknown', () => {
    // `null` is "we did not look" — an absent summary must never render as "empty".
    renderOption(candidate(), null)
    expect(screen.queryByTestId('project-attach-opt-holdings-d1')).toBeNull()
  })

  it('is SEARCHABLE by name and by the visible type label, never by the uuid', () => {
    const opt = buildAttachOption(
      candidate({ id: '11111111-2222-3333-4444-555555555555' }),
      { typeLabel: 'Probe matrix', holdings: null },
    )
    // The label is a NODE, so with no `searchText` the kit falls back to the option
    // VALUE — the uuid — and typing a name matches nothing. This is that guard.
    expect(opt.searchText).toContain('Donor A')
    expect(opt.searchText).toContain('Probe matrix')
    expect(opt.searchText).not.toContain('11111111')
    expect(typeof opt.label).not.toBe('string') // the premise of the guard still holds
  })

  it('keeps the collapsed trigger to the name alone', () => {
    const opt = buildAttachOption(candidate(), { typeLabel: 'Probe matrix', holdings: null })
    expect(opt.selectedLabel).toBe('Donor A')
  })

  it('truncates both lines, so a long name shortens instead of reflowing the row', () => {
    const long = `A-deliberately-very-long-human-written-dataset-name-${'x'.repeat(120)}`
    renderOption(candidate({ name: long }), { text: '3 artifacts', detail: '3 artifacts' })
    expect(screen.getByText(long).className).toContain('truncate')
    expect(screen.getByTestId('project-attach-opt-holdings-d1').className).toContain('truncate')
  })
})

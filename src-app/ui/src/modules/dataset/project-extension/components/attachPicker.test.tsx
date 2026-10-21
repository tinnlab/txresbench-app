// @vitest-environment jsdom
//
// The picker's options driven through the REAL kit `<Select>` — the two properties
// that only appear once the control is actually rendering them:
//
//   1. an option is still reachable by ACCESSIBLE NAME. Five e2e specs select with
//      `getByRole('option', { name: <dataset name> })`, and this change made the
//      option's label a two-line node with a status badge and a holdings line in it.
//      A pure test of the option OBJECT cannot see that.
//   2. typing a dataset's NAME narrows the list to it. That did not work: past
//      `SELECT_SEARCH_THRESHOLD` options the kit filters on `searchText` falling back
//      to a string label and then to the option VALUE — and this picker's label is a
//      NODE, so the fallback was the dataset's uuid.

import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Select, SELECT_SEARCH_THRESHOLD, type SelectOption } from '@ziee/kit'
import { buildAttachOption } from './attachOptionRow'
import type { AttachCandidate } from './attachOptions'

beforeEach(() => {
  cleanup()
})

const UUID = (n: number) => `${String(n).padStart(8, '0')}-2222-3333-4444-555555555555`

const candidate = (n: number, over: Partial<AttachCandidate> = {}): AttachCandidate => ({
  id: UUID(n),
  name: `Donor ${String.fromCharCode(65 + n)}`,
  datatype: 'probe/matrix',
  source: 'owned',
  ...over,
})

const option = (c: AttachCandidate): SelectOption =>
  buildAttachOption(c, {
    typeLabel: 'Probe matrix',
    holdings: { text: '120 rows x 36 spans', detail: '120 rows x 36 spans · 2.0 KB' },
  })

function openPicker(options: SelectOption[]) {
  render(
    <Select
      data-testid="pick"
      options={options}
      value=""
      onChange={() => {}}
      aria-label="Dataset to link to this project"
      searchPlaceholder="Search datasets…"
      emptyText="No dataset matches that name"
    />,
  )
  const trigger = screen.getByTestId('pick')
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.click(trigger)
}

describe('the attach picker, driven through the real kit Select', () => {
  it('an option is still reachable by ACCESSIBLE NAME after the row grew a second line', async () => {
    const c = candidate(0)
    openPicker([option(c)])
    // The exact selector five e2e specs use.
    await waitFor(() => expect(screen.getByRole('option', { name: /Donor A/ })).toBeTruthy())
    // …and the extra content really is in there, so this is not passing on a bare row.
    expect(screen.getByTestId(`pick-opt-${c.id}`).textContent).toContain('120 rows x 36 spans')
  })

  it('a NOT-READY dataset is offered by the control, marked, and selectable', async () => {
    const broken = candidate(1, { processingStatus: 'failed', processingError: 'exit 2' })
    openPicker([option(candidate(0)), option(broken)])
    await waitFor(() => expect(screen.getByTestId(`pick-opt-${broken.id}`)).toBeTruthy())
    const row = screen.getByTestId(`pick-opt-${broken.id}`)
    // marked …
    expect(row.textContent).toMatch(/failed/i)
    // … and NOT disabled: linking a broken dataset is explained, never blocked.
    expect(row.getAttribute('aria-disabled')).toBeNull()
  })

  it('typing a NAME narrows the list to that dataset — and the uuid does NOT', async () => {
    // Past the threshold the kit renders its searchable arm. Derived from the kit's
    // own exported constant, so this cannot drift away from the real switch point.
    const many = Array.from({ length: SELECT_SEARCH_THRESHOLD + 2 }, (_, i) => candidate(i))
    openPicker(many.map(option))
    const search = await screen.findByTestId('pick-search')

    fireEvent.change(search, { target: { value: 'Donor C' } })
    await waitFor(() => {
      expect(screen.getByTestId(`pick-opt-${many[2].id}`)).toBeTruthy()
      expect(screen.queryByTestId(`pick-opt-${many[0].id}`)).toBeNull()
    })

    // NEGATIVE CONTROL — the pre-change behaviour was that the haystack WAS the uuid.
    // If it still were, this query would match one row instead of none.
    fireEvent.change(search, { target: { value: many[2].id } })
    await waitFor(() => expect(screen.getByTestId('pick-no-match')).toBeTruthy())
    expect(screen.queryByTestId(`pick-opt-${many[2].id}`)).toBeNull()

    // POSITIVE CONTROL — clearing the query restores the full list, so the assertion
    // above is about the FILTER and not about a list that stopped rendering.
    fireEvent.change(search, { target: { value: '' } })
    await waitFor(() => expect(screen.getByTestId(`pick-opt-${many[0].id}`)).toBeTruthy())
  })

  it('the datatype label is searchable too (both of the row\'s visible words)', async () => {
    const many = Array.from({ length: SELECT_SEARCH_THRESHOLD + 2 }, (_, i) => candidate(i))
    openPicker(many.map(option))
    const search = await screen.findByTestId('pick-search')
    fireEvent.change(search, { target: { value: 'probe matr' } })
    await waitFor(() => expect(screen.getByTestId(`pick-opt-${many[0].id}`)).toBeTruthy())
  })
})

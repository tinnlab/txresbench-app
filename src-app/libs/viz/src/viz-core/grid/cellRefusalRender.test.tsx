// @vitest-environment jsdom
//
// cellRefusalRender.test.tsx — TEST-3 / TEST-5, the two acceptance proofs that a refusal
// REACHES THE USER and that it is told apart from a deliberate choice.
//
// ── WHY THESE MOUNT, AND DO NOT READ A FLAG ────────────────────────────────────────────────
//
// The unit proof next door (`registry/bindingRefusal.test.ts`) shows the resolver refuses.
// That is necessary and not sufficient: a refusal nothing renders is indistinguishable from
// the guess it replaced — the user gets a pane with no chart in it either way, and no reason.
// So these assert the DOM a user actually gets, through the real dispatch (`ChartBody`), and
// they would pass just as well against a resolver that refused into a blank pane — which is
// exactly the outcome they exist to reject.
//
// ── THE TRAP TEST-5 IS BUILT AROUND ────────────────────────────────────────────────────────
//
// The short way to write the render gate is `if (!bindings[channel.id]) return <refusal/>`.
// It is wrong, and vacuously so: a channel that is DELIBERATELY unbound — an author's
// explicit `''`, which is viz's in-band "bind no column" — is also absent from `bindings`.
// That gate would put a refusal over every legitimately ungrouped chart, re-breaking the
// defect `4e49c9b0` fixed ("an unset optional channel means UNGROUPED, not 'pick a column for
// me'"). The gate has to read the RESOLVED FACT (INV-5), and the only way to tell the two
// implementations apart is to drive BOTH cases and require different renders.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DatasetCatalog, DataSource } from '../data/wire'
import { installBuiltins } from '../charts/installBuiltins'
import { defaultCoordinationHandle } from '../../adapter/coordinationHandle'
import { ChartBody } from './CellView'
import type { GridCell } from './gridModel'

beforeAll(() => {
  installBuiltins()
})
afterEach(() => cleanup())

function makeCatalog(over: Partial<DatasetCatalog> = {}): DatasetCatalog {
  return {
    datasetId: 'test',
    pointCount: 10,
    layouts: [],
    valueColumns: [],
    categoricalColumns: [],
    continuousColumns: [],
    hasImage: false,
    ...over,
  }
}

/** A source the refusal path never touches, and the positive-control path only starts. */
function stubSource(catalog: DatasetCatalog): DataSource {
  return {
    catalog: async () => catalog,
    positions: async () => ({ positions: new Float32Array(0), length: 0 }),
    valueColumn: async () => ({ row: new Uint32Array(0), value: new Float32Array(0), length: 0 }),
    categorical: async () => ({ codes: new Uint16Array(0), categories: [], length: 0 }),
    continuous: async () => ({ value: new Float32Array(0), length: 0 }),
  } as unknown as DataSource
}

function cell(kind: string, bindings?: GridCell['bindings']): GridCell {
  return { id: 'c1', kind, layoutId: 'l1', ...(bindings ? { bindings } : {}) }
}

function renderBody(c: GridCell, catalog: DatasetCatalog) {
  return render(
    <ChartBody
      cell={c}
      source={stubSource(catalog)}
      catalog={catalog}
      coordination={defaultCoordinationHandle}
    />,
  )
}

/** Two categorical + two value columns: every single-column channel is undecidable. */
const AMBIGUOUS = makeCatalog({
  categoricalColumns: [
    { id: 'donor', kind: 'categorical', label: 'Donor' },
    { id: 'batch', kind: 'categorical', label: 'Batch' },
  ],
  valueColumns: ['pct_mito', 'n_counts'],
})

/** One of each: nothing is a choice, so everything binds. */
const DECIDABLE = makeCatalog({
  categoricalColumns: [{ id: 'donor', kind: 'categorical', label: 'Donor' }],
  valueColumns: ['pct_mito'],
})

describe('TEST-3 [acceptance][INV-3] — a refused REQUIRED binding is visible and says why', () => {
  it('names the channel and the candidate columns, instead of drawing a chart', () => {
    renderBody(cell('violin'), AMBIGUOUS)
    const box = screen.getByTestId('viz-chart-unbound')
    expect(box).toBeTruthy()
    const text = box.textContent ?? ''
    // (a) it names the CHANNEL by its human label — "Value" is the violin's value channel.
    expect(text).toMatch(/Value/)
    // (b) it names the CANDIDATES. "this binding is ambiguous" is not actionable; "these two
    //     columns both qualify" is — the same reasoning contract.ts applies to axis labels.
    expect(text).toContain('pct_mito')
    expect(text).toContain('n_counts')
    // (c) it is not the chart, and not the unregistered-kind fallback either.
    expect(screen.queryByTestId('viz-cell-unsupported')).toBeNull()
  })

  it('POSITIVE CONTROL — the same cell with a decidable catalog renders the chart, not a refusal', () => {
    // Without this leg, "the refusal is visible" would also pass on a build where the pane
    // ALWAYS shows a refusal — a different defect wearing this fix's clothes. The chart having
    // MOUNTED is proven by its own loading state, which only `useAsyncChartData` renders.
    const { container } = renderBody(cell('violin'), DECIDABLE)
    expect(screen.queryByTestId('viz-chart-unbound')).toBeNull()
    expect(screen.queryByTestId('viz-cell-unsupported')).toBeNull()
    expect(document.body.textContent ?? '').not.toMatch(/Choose a column to plot/)
    // POSITIVE, not merely three absences. A control made of absences passes on a pane that
    // rendered NOTHING — which is the outcome this file's own header says it exists to reject,
    // so a control that cannot see it is the same hollow test one level up. The chart View
    // MOUNTED and began loading: only `useAsyncChartData` puts that in the DOM, and only a
    // dispatched View calls it.
    expect(container.textContent ?? '').not.toEqual('')
    expect(container.textContent).toMatch(/Loading/)
  })

  it('caps the candidate list so a wide catalog cannot overflow the pane', () => {
    const wide = makeCatalog({
      categoricalColumns: [{ id: 'donor', kind: 'categorical', label: 'Donor' }],
      valueColumns: Array.from({ length: 40 }, (_, i) => `gene_${i}`),
    })
    renderBody(cell('violin'), wide)
    const text = screen.getByTestId('viz-chart-unbound').textContent ?? ''
    expect(text).toMatch(/\+\d+ more/)
    // the elision is real: it did not just print all forty
    expect(text).not.toContain('gene_39')
  })

  it('an UNREGISTERED kind still gets its own fallback — the refusal did not swallow it', () => {
    renderBody(cell('zz-no-such-chart-kind'), AMBIGUOUS)
    expect(screen.getByTestId('viz-cell-unsupported')).toBeTruthy()
    expect(screen.queryByTestId('viz-chart-unbound')).toBeNull()
  })
})

describe('TEST-5 [acceptance][INV-5] — the gate reads the RESOLVED FACT, not an absent value', () => {
  it('a DELIBERATELY unbound REQUIRED channel renders the chart, NOT a refusal', () => {
    // The author said `''` — "no column, on purpose". `bindings.value` is absent from the
    // wire in exactly the way an undecidable channel's is, so a gate written as
    // `!bindings.value` cannot tell them apart, and would show a refusal over a decision the
    // author explicitly made. The chart renders (its own empty state owns the no-data case).
    renderBody(cell('violin', { value: '', group: 'donor' }), AMBIGUOUS)
    expect(screen.queryByTestId('viz-chart-unbound')).toBeNull()
  })

  it('…while the SAME channel merely UNDECIDED refuses — the two must render differently', () => {
    // Identical catalog, identical cell but for the one channel. `bindings.value` is absent in
    // BOTH cases; only the RESOLUTIONS differ (`unbound` vs `ambiguous`). This pair is the
    // whole discrimination: a `!bindings[id]` gate renders them identically and this assertion
    // is what goes red on it.
    //
    // It is deliberately driven on a REQUIRED channel. On an OPTIONAL one both cases render
    // the chart by design (DEC-5 — "ungrouped" is the honest answer for an undecided
    // grouping), so an optional channel cannot discriminate the two implementations at all —
    // which is how the first draft of this test passed vacuously against both.
    const declared = renderBody(cell('violin', { value: '', group: 'donor' }), AMBIGUOUS)
    const declaredText = declared.container.textContent ?? ''
    expect(declaredText).not.toMatch(/Choose a column to plot/)
    cleanup()
    const undecided = renderBody(cell('violin', { group: 'donor' }), AMBIGUOUS)
    const undecidedText = undecided.container.textContent ?? ''
    expect(undecidedText).toMatch(/Choose a column to plot/)
    expect(undecidedText).not.toEqual(declaredText)
  })

  it('an OPTIONAL channel that cannot be decided stays unbound and does NOT refuse (DEC-5)', () => {
    // The complement, pinned so a later "make everything refuse" change cannot pass: violin's
    // grouping is declared `optional`, and an undecidable grouping means UNGROUPED — the
    // defect `4e49c9b0` fixed. Value binds solely here, so the grouping is the only thing that
    // could raise a refusal.
    const oneValueTwoCats = makeCatalog({
      categoricalColumns: [
        { id: 'donor', kind: 'categorical', label: 'Donor' },
        { id: 'batch', kind: 'categorical', label: 'Batch' },
      ],
      valueColumns: ['pct_mito'],
    })
    renderBody(cell('violin'), oneValueTwoCats)
    expect(screen.queryByTestId('viz-chart-unbound')).toBeNull()
  })

  it('a required channel that is ABSENT (no column of that kind at all) also refuses', () => {
    // `absent` and `ambiguous` are different silences but the same user-facing consequence:
    // nobody has said what to draw. Both must surface; only their sentence differs.
    const noValues = makeCatalog({
      categoricalColumns: [{ id: 'donor', kind: 'categorical', label: 'Donor' }],
    })
    renderBody(cell('violin'), noValues)
    const text = screen.getByTestId('viz-chart-unbound').textContent ?? ''
    expect(text).toMatch(/no value column/i)
  })
})

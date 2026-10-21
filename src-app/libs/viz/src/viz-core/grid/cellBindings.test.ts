import { describe, it, expect } from 'vitest'
import { isDenseKind, swapCellContent, type CellKind } from './gridModel'
import { resolveBindingChannel } from '../registry/model'
import type { DatasetCatalog } from '../data/wire'
import { FixtureSource } from '../data/fixtures'
import { installBuiltins } from '../charts/installBuiltins'
import { createGridWorkspaceStore } from '../../adapter/GridWorkspace.store'

// `isDenseKind` resolves a kind's coordinate system against the chart-type REGISTRY
// (EXTENSIBILITY_STUDY Part 6 STEP 1), so the built-ins must be registered first.
// Idempotent.
installBuiltins()

// ---------------------------------------------------------------------------
// isDenseKind — the dense (shared-deck) vs. chart (own-ChartCanvas) partition.
// ---------------------------------------------------------------------------

describe('isDenseKind', () => {
  it('is true ONLY for the dense kinds (scatter / image)', () => {
    expect(isDenseKind('scatter')).toBe(true)
    expect(isDenseKind('image')).toBe(true)
  })

  it('is false for every chart kind (they render their own ChartCanvas)', () => {
    const chartKinds: CellKind[] = [
      'violin',
      'box',
      'bar',
      'histogram',
      'dotplot',
      'heatmap',
      'volcano',
      'grid',
    ]
    for (const k of chartKinds) expect(isDenseKind(k)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// TEST-8 — there is exactly ONE binding resolver, and it refuses.
//
// This block used to test `gridModel.defaultBindings`, a byte-identical SECOND copy of the
// registry resolver's guess at ordinal 0 ("picks first categorical as group, first 6 values,
// first continuous", and "falls back to conventional ids on an empty catalog" — i.e. to the
// literals `'group'` and `'qcA'`). Both the function and its assertions are gone with the
// duplicate: what remains is that the ONE resolver is the only one, and that it refuses
// rather than picking a position. See `docs/design/binding-resolution-refusal.md`.
// ---------------------------------------------------------------------------

/** Build a minimal catalog with the given columns overriding the empty defaults. */
function makeCatalog(over: Partial<DatasetCatalog> = {}): DatasetCatalog {
  return {
    datasetId: 'test',
    pointCount: 100,
    layouts: [],
    valueColumns: [],
    categoricalColumns: [],
    continuousColumns: [],
    hasImage: false,
    ...over,
  }
}

describe('TEST-8 — one resolver, and it does not pick a position', () => {
  it('gridModel exports no second binding resolver', async () => {
    const mod = (await import('./gridModel')) as Record<string, unknown>
    // The duplicate is GONE, not renamed: nothing in this module resolves bindings any more.
    expect(mod.defaultBindings).toBeUndefined()
    expect(Object.keys(mod).filter(k => /^default.*Bindings$/i.test(k))).toEqual([])
  })

  it('the catalog that used to yield group/A/qcA now refuses every undecidable channel', () => {
    const catalog = makeCatalog({
      categoricalColumns: [
        { id: 'group', kind: 'categorical', label: 'Group' },
        { id: 'type', kind: 'categorical', label: 'Type' },
      ],
      valueColumns: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
      continuousColumns: [
        { id: 'qcA', kind: 'continuous', label: 'QC A' },
        { id: 'qcB', kind: 'continuous', label: 'QC B' },
      ],
    })
    // `value` used to be 'A' (valueColumns[0]); `continuous` used to be 'qcA'.
    expect(
      resolveBindingChannel({ id: 'value', source: 'value', label: 'V' }, catalog).status,
    ).toBe('ambiguous')
    expect(
      resolveBindingChannel({ id: 'value', source: 'continuous', label: 'V' }, catalog).status,
    ).toBe('ambiguous')
    // an id-match is evidence and still binds, wherever the column sits
    expect(resolveBindingChannel({ id: 'type', source: 'categorical', label: 'T' }, catalog)).toEqual(
      { status: 'bound', column: 'type' },
    )
  })

  it('an EMPTY catalog yields `absent`, never the conventional literals', () => {
    const empty = makeCatalog()
    for (const source of ['categorical', 'continuous', 'value'] as const) {
      const r = resolveBindingChannel({ id: 'x', source, label: 'X' }, empty)
      expect(r).toEqual({ status: 'absent', source })
    }
  })

  it('derives real bindings from the fixture catalog, naming only columns it carries', async () => {
    const catalog = await new FixtureSource({ seed: 7, pointCount: 1000 }).catalog()
    const r = resolveBindingChannel({ id: 'group', source: 'categorical', label: 'G' }, catalog)
    // The fixture catalog DOES carry a `group` categorical column, so this must BIND — asserted
    // unconditionally. Guarded as `if (r.status === 'bound')` the test passes asserting nothing
    // the moment the resolver starts refusing, which is precisely what it is here to notice.
    expect(r).toEqual({ status: 'bound', column: 'group' })
    expect(catalog.categoricalColumns.map(c => c.id)).toContain('group')
  })
})

// ── a kind switch must not silently re-pick the user's columns ───────────────────────────────
//
// Reported on the live app: plot `pct_mito` (a percentage), switch the pane violin → box → back,
// and the axis reads 0–50K. That is not a rescale — it is a DIFFERENT column, the scRNA counts
// column, which is simply the first `value` column in the catalog.
//
// The mechanism is the kind switcher's carry rule. `carryCompatibleBindings` keeps a channel only
// when the TARGET declares one the SOURCE also declares with the same `source` kind. Violin's
// value channel is `source:'value'`; histogram's is `source:'continuous'`. So violin→histogram
// carries NOTHING, returns `undefined`, and the cell's bindings are CLEARED — permanently. Coming
// back to violin there is nothing left to restore, so it resolves `valueColumns[0]` and paints a
// different column with total confidence. violin→bar loses the value channel the same way (bar
// declares no value channel at all).
//
// Clearing the ACTIVE binding is right — a value column must not survive onto a continuous channel.
// Forgetting it is not. The cell now REMEMBERS each binding under its channel VOCABULARY
// (`<id>:<source>`), so a switch away parks the pick and a switch back restores it, while a
// channel of a different vocabulary still starts from the target's own catalog default.
describe('kind switch preserves the user column picks (round trip)', () => {
  const seed = () => {
    const store = createGridWorkspaceStore()
    const id = Object.keys(store.getState().cells)[0]
    store.setState(prev => ({
      cells: {
        ...prev.cells,
        [id]: { ...prev.cells[id], kind: 'violin' as CellKind, bindings: { value: 'pct_mito', group: 'ident' } },
      },
    }))
    return { store, id }
  }

  it.each(['box', 'histogram', 'bar'] as const)(
    'violin → %s → violin restores the SAME value + group columns',
    via => {
      const { store, id } = seed()
      store.getState().setCellKind(id, via)
      store.getState().setCellKind(id, 'violin')
      const back = store.getState().cells[id]
      expect(back.kind).toBe('violin')
      expect(
        back.bindings,
        `round-tripping through "${via}" must not re-pick the columns from the catalog`,
      ).toMatchObject({ value: 'pct_mito', group: 'ident' })
    },
  )

  it('does NOT carry a value column onto a channel of a different vocabulary', () => {
    const { store, id } = seed()
    store.getState().setCellKind(id, 'histogram')
    // histogram's `value` is a CONTINUOUS channel; the violin's value-column pick must not ride
    // onto it (that was the round-2 stale-binding fix, and it still holds).
    expect(store.getState().cells[id].bindings?.value).toBeUndefined()
  })

  it('a NEW pick on the target wins over the remembered one when switching back', () => {
    const { store, id } = seed()
    store.getState().setCellKind(id, 'box')
    store.setState(prev => ({
      cells: { ...prev.cells, [id]: { ...prev.cells[id], bindings: { value: 'nCount', group: 'ident' } } },
    }))
    store.getState().setCellKind(id, 'violin')
    expect(store.getState().cells[id].bindings).toMatchObject({ value: 'nCount' })
  })
})

// A drag-swap trades what two panes DISPLAY. The parked picks exist only to restore `bindings` on a
// kind switch, so they are content: leaving them behind would let a swapped cell later "restore"
// the other cell's columns — the same silent-wrong-column failure, arriving one gesture later.
describe('swapCellContent trades the parked picks with the bindings', () => {
  it('each cell ends up with the OTHER cell memo', () => {
    const a = {
      id: 'a',
      kind: 'violin' as CellKind,
      layoutId: 'primary',
      bindings: { value: 'pct_mito' },
      bindingMemo: { 'value:value': 'pct_mito' },
    }
    const b = {
      id: 'b',
      kind: 'box' as CellKind,
      layoutId: 'primary',
      bindings: { value: 'nCount' },
      bindingMemo: { 'value:value': 'nCount' },
    }
    const [aNext, bNext] = swapCellContent(a, b)
    expect(aNext.bindingMemo).toEqual({ 'value:value': 'nCount' })
    expect(bNext.bindingMemo).toEqual({ 'value:value': 'pct_mito' })
    // identity + slot stay put (the existing contract).
    expect(aNext.id).toBe('a')
    expect(bNext.id).toBe('b')
  })
})

// `setCellKind` short-circuits a same-kind call, and its comment has always said that call "MUST
// preserve bindings". Nothing held that window: deleting the guard broke no test, because the memo
// path happens to rebuild an equal binding set. It is still not a no-op — it re-creates the cell
// object (churning identity for every memoized consumer) and would drop any binding key the chart's
// schema does not declare. Pin the contract the comment already states.
describe('setCellKind is a true no-op for the kind it already has', () => {
  it('keeps the bindings AND the cell object identity', () => {
    const store = createGridWorkspaceStore()
    const id = Object.keys(store.getState().cells)[0]
    store.setState(prev => ({
      cells: {
        ...prev.cells,
        [id]: { ...prev.cells[id], kind: 'violin' as CellKind, bindings: { value: 'pct_mito', group: 'ident' } },
      },
    }))
    const before = store.getState().cells[id]
    store.getState().setCellKind(id, 'violin')
    const after = store.getState().cells[id]
    expect(after).toBe(before)
    expect(after.bindings).toEqual({ value: 'pct_mito', group: 'ident' })
  })
})

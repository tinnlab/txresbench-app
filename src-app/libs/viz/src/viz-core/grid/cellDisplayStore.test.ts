// cellDisplayStore.test.ts — TEST-22 (ITEM-21 / Split 0b, DEC-21).
//
// The store exists for ONE reason: a write to cell A must not invalidate cell B's subscription.
// `useStore(store, selector)` compares the selector's RESULT by identity, so that reason is only
// served if the per-cell selector is referentially stable across an unrelated write. Everything
// below is that property, plus the round-trip of the keys actually hoisted.
//
// ── THE KEY COUNT, RE-DERIVED 2026-07-29 (the plan's number was wrong twice over) ────────────────
// PLAN.md said TEN. The 2026-07-28 re-derivation corrected it to EIGHT, and flagged seven further
// per-cell states as "triage in or out before this test is written". Resolved here as SEVEN hoisted
// records + ONE narrowed (already-store-backed) value:
//
//   HOISTED (7, this store)   colors, legend, groupLegend, valueLegend, hiddenCodes, colorData,
//                             plotRows
//   NARROWED (1, elsewhere)   perCellRange — already lives in `PlotInteraction.store.filters`,
//                             which must stay the SINGLE SERIALIZE SOURCE for `option.filters`
//                             (DEC-13). Its hoist was done by merge `7e35c62c`; its DECOUPLING was
//                             not, and that is `selectPlotFilter` (asserted at the bottom).
//
//   TRIAGED OUT (9)  committedByCell + maskReview      — selection geometry / mask-authoring review,
//                                                        not display description
//                    annotateEpoch + maskEpoch         — global scalars, not per-cell
//                    imageUnderlays + imagePyramids +
//                    maskData                          — GPU textures / large decoded buffers with a
//                                                        'loading' sentinel and a release path
//                    crossHighlight + chartHover       — per-FRAME hover transients (chartHover is
//                                                        not even cell-keyed)
// The full rule + reasoning lives in the header of `CellDisplay.store.ts`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createCellDisplayStore,
  selectCell,
  mergeRecord,
  sameDisplayValue,
  EMPTY_CELL_DISPLAY,
  type CellDisplaySlice,
} from '../../adapter/CellDisplay.store'
import { createPlotInteractionStore, selectPlotFilter } from '../../adapter/PlotInteraction.store'

/** The seven records this store hoisted. Named once so the round-trip test cannot silently cover
 *  six of them. */
const HOISTED_KEYS = [
  'colors',
  'legend',
  'groupLegend',
  'valueLegend',
  'hiddenCodes',
  'colorData',
  'plotRows',
] as const

const legend = (title: string) => ({ descriptor: { kind: 'categorical' as const, entries: [] } as never, title })

describe('CellDisplay store — the per-cell display slice (TEST-22)', () => {
  it('declares exactly the seven hoisted records and nothing else', () => {
    const st = createCellDisplayStore().getState()
    const records = Object.entries(st)
      .filter(([, v]) => typeof v !== 'function')
      .map(([k]) => k)
      .sort()
    expect(records).toEqual([...HOISTED_KEYS].sort())
  })

  it('round-trips all seven hoisted keys', () => {
    const store = createCellDisplayStore()
    const st = () => store.getState()

    const colors = { colors: new Uint8Array([1, 2, 3, 4]), epoch: 7 }
    const lg = legend('by cluster')
    const glg = legend('by group')
    const vlg = { colormap: 'viridis' as never, domain: [0, 10] as readonly [number, number] }
    const hidden = new Set([1, 3])
    const cd = { column: 'cluster', categorical: true, categories: ['a', 'b'] }
    const rows = { columns: ['x'], rows: [[1]] as (string | number)[][] }

    st().setColors('A', colors)
    st().replaceLegend({ A: lg })
    st().replaceGroupLegend({ A: glg })
    st().setValueLegend('A', vlg)
    st().setHiddenCodes('A', hidden)
    st().replaceColorData({ A: cd })
    st().setPlotRows('A', rows)

    const a = selectCell('A')(st())
    expect(a.colors).toBe(colors)
    expect(a.legend).toBe(lg)
    expect(a.groupLegend).toBe(glg)
    expect(a.valueLegend).toBe(vlg)
    expect(a.hiddenCodes).toBe(hidden)
    expect(a.colorData).toBe(cd)
    expect(a.plotRows).toBe(rows)
    // Every hoisted key is exercised above — a key added to the store without a round-trip here
    // fails the declaration test, so this pair cannot drift apart.
    expect(Object.keys(a).sort()).toEqual([...HOISTED_KEYS].sort())
  })

  // THE load-bearing property. Without it the hoist is a regression: every cell's subscriber would
  // re-render on every other cell's change, which is worse than the `useState` it replaced.
  it('a write to cell A leaves cell B’s resolved slice REFERENTIALLY identical', () => {
    const store = createCellDisplayStore()
    const st = () => store.getState()
    const selA = selectCell('A')
    const selB = selectCell('B')

    st().setHiddenCodes('A', new Set([1]))
    st().setHiddenCodes('B', new Set([2]))
    const b0 = selB(st())
    const a0 = selA(st())

    // …every kind of write to A, one at a time.
    st().setColors('A', { colors: new Uint8Array([9]), epoch: 1 })
    expect(selB(st())).toBe(b0)
    st().setHiddenCodes('A', new Set([1, 5]))
    expect(selB(st())).toBe(b0)
    st().setValueLegend('A', { colormap: 'magma' as never, domain: [0, 1] })
    expect(selB(st())).toBe(b0)
    st().setPlotRows('A', { columns: ['x'], rows: [] })
    expect(selB(st())).toBe(b0)

    // …and A itself really did change (a negative control: the isolation above must not be the
    // trivial consequence of nothing having happened).
    expect(selA(st())).not.toBe(a0)
  })

  it('a re-read with no write at all is referentially identical for both cells', () => {
    const store = createCellDisplayStore()
    const selA = selectCell('A')
    const selB = selectCell('B')
    store.getState().setHiddenCodes('A', new Set([1]))
    store.getState().setHiddenCodes('B', new Set([2]))
    const firstA = selA(store.getState())
    // FIX_ROUND-2 / C23: the name says BOTH cells; the body exercised only A. `selB` and cell B were
    // declared nowhere in it, so "both" was covered 1x.
    const firstB = selB(store.getState())
    expect(selA(store.getState())).toBe(firstA)
    expect(selB(store.getState())).toBe(firstB)
  })

  it('a no-op write does not invalidate the cell it targets', () => {
    const store = createCellDisplayStore()
    const selA = selectCell('A')
    const codes = new Set([1])
    store.getState().setHiddenCodes('A', codes)
    const a0 = selA(store.getState())
    store.getState().setHiddenCodes('A', codes) // same identity in
    expect(selA(store.getState())).toBe(a0)
  })

  it('an unknown cell resolves to the ONE shared empty identity, not a fresh object', () => {
    const store = createCellDisplayStore()
    const selZ = selectCell('Z')
    expect(selZ(store.getState())).toBe(EMPTY_CELL_DISPLAY)
    // …and stays that identity after an unrelated cell is written, which is what a subscriber for a
    // not-yet-colored cell depends on.
    store.getState().setColors('A', { colors: new Uint8Array([1]), epoch: 1 })
    expect(selZ(store.getState())).toBe(EMPTY_CELL_DISPLAY)
    expect(selectCell('Q')(store.getState())).toBe(EMPTY_CELL_DISPLAY)
  })

  it('removeCell prunes every record for that cell and leaves the others alone', () => {
    const store = createCellDisplayStore()
    const st = () => store.getState()
    for (const id of ['A', 'B']) {
      st().setColors(id, { colors: new Uint8Array([1]), epoch: 1 })
      st().setHiddenCodes(id, new Set([1]))
      st().setValueLegend(id, { colormap: 'viridis' as never, domain: [0, 1] })
      st().setPlotRows(id, { columns: [], rows: [] })
    }
    st().replaceLegend({ A: legend('a'), B: legend('b') })
    st().replaceGroupLegend({ A: legend('ga'), B: legend('gb') })
    st().replaceColorData({ A: { column: 'c', categorical: true }, B: { column: 'c', categorical: true } })

    const selB = selectCell('B')
    const b0 = selB(st())
    st().removeCell('A')

    expect(selectCell('A')(st())).toBe(EMPTY_CELL_DISPLAY)
    for (const k of HOISTED_KEYS) expect(('A' in (st() as unknown as CellDisplaySlice)[k]), `${k} must be pruned`).toBe(false)
    expect(selB(st())).toBe(b0) // B untouched, identity preserved
  })

  it('reset clears every record', () => {
    const store = createCellDisplayStore()
    store.getState().setColors('A', { colors: new Uint8Array([1]), epoch: 1 })
    store.getState().reset()
    expect(selectCell('A')(store.getState())).toBe(EMPTY_CELL_DISPLAY)
  })

  it('two store instances are fully independent (INV-7: one store per workspace)', () => {
    const a = createCellDisplayStore()
    const b = createCellDisplayStore()
    a.getState().replaceColors({ C1: { colors: new Uint8Array([1]), epoch: 1 } })
    expect(selectCell('C1')(b.getState())).toBe(EMPTY_CELL_DISPLAY)
    // The failure this guards: a family-level (shared) slice would let a popped-out container's
    // whole-record `replaceColors` wipe the main grid's entry for the same cell id.
    b.getState().replaceColors({})
    expect(selectCell('C1')(a.getState()).colors).toBeDefined()
  })
})

// ── THE WHOLE-RECORD WRITE PATH (FIX_ROUND-2: the `memo(GridPaneCell)` residual) ──────────────────
// The isolation tests above all drive the SINGLE-cell actions, which route through `put` and have
// always preserved identity. The four `replace*` actions did not, and they are the ones the recolor
// / legend effects actually call — keyed on a WHOLE-GRID `colorSig`, so one pane's legend click
// handed this store a freshly-allocated entry for EVERY pane. Measured on the TEST-F5 drive: for the
// untouched pane the new color buffer was byte-identical (320,000 bytes), its `colorData` equal and
// its legend JSON-equal — three pure-noise identity changes, each of which woke that pane's
// subscription and re-rendered its chrome THROUGH the memo boundary (a store subscription does not
// consult `memo`). The `epoch` bump additionally re-uploaded an unchanged GPU attribute.
describe('CellDisplay store — whole-record replace preserves per-entry identity', () => {
  const colorsOf = (bytes: number[], epoch: number) => ({ colors: new Uint8Array(bytes), epoch })

  it('replaceColors keeps the previous entry (AND its epoch) when the buffer is byte-identical', () => {
    const store = createCellDisplayStore()
    const st = () => store.getState()
    const selA = selectCell('A')
    const selB = selectCell('B')
    st().replaceColors({ A: colorsOf([1, 2, 3, 4], 1), B: colorsOf([5, 6, 7, 8], 2) })
    const a0 = selA(st())
    const b0 = selB(st())

    // The recolor pass re-runs for the whole grid: A's bytes moved, B's did not. B must be untouched
    // — same object, same epoch — and A must be the new one.
    st().replaceColors({ A: colorsOf([9, 9, 9, 9], 3), B: colorsOf([5, 6, 7, 8], 4) })
    expect(selB(st()), 'an untouched pane must not be re-rendered by another pane’s recolor').toBe(b0)
    expect(selB(st()).colors?.epoch, 'an unchanged buffer must keep its epoch — the epoch IS the deck updateTrigger').toBe(2)
    expect(selA(st())).not.toBe(a0)
    expect(selA(st()).colors?.epoch).toBe(3)
  })

  it('replaceLegend / replaceGroupLegend / replaceColorData keep structurally-equal entries', () => {
    const store = createCellDisplayStore()
    const st = () => store.getState()
    const selB = selectCell('B')
    const mkLegend = (title: string) => ({
      descriptor: { kind: 'categorical' as const, entries: [{ code: 1, label: 'x', color: [1, 2, 3] }] } as never,
      title,
      values: new Float32Array([1.5, 2.5]),
      rawLabels: ['x'],
    })
    const mkData = () => ({ column: 'cluster', categorical: false, values: new Float32Array([1, 2, 3]) })

    st().replaceLegend({ B: mkLegend('by cluster') })
    st().replaceGroupLegend({ B: mkLegend('by group') })
    st().replaceColorData({ B: mkData() })
    const b0 = selB(st())

    // Freshly-built but equal values (what the legend effect produces on every `colorSig` pass).
    st().replaceLegend({ B: mkLegend('by cluster') })
    st().replaceGroupLegend({ B: mkLegend('by group') })
    st().replaceColorData({ B: mkData() })
    expect(selB(st()), 'a rebuilt-but-equal legend/colorData must not invalidate the cell').toBe(b0)

    // …and a REAL change still lands (the negative control).
    st().replaceLegend({ B: mkLegend('by sample') })
    expect(selB(st())).not.toBe(b0)
    expect(selB(st()).legend?.title).toBe('by sample')
  })

  it('replace still adds, drops and overwrites — identity preservation is not a write barrier', () => {
    const store = createCellDisplayStore()
    const st = () => store.getState()
    st().replaceColors({ A: colorsOf([1], 1), B: colorsOf([2], 2) })
    st().replaceColors({ A: colorsOf([1], 9) }) // B dropped, A byte-identical
    expect(selectCell('B')(st())).toBe(EMPTY_CELL_DISPLAY)
    expect(selectCell('A')(st()).colors?.epoch).toBe(1)
    st().replaceColors({}) // the "no colorBy anywhere" reset
    expect(selectCell('A')(st())).toBe(EMPTY_CELL_DISPLAY)
  })

  it('sameDisplayValue compares typed arrays and Sets by CONTENT, and rejects real differences', () => {
    expect(sameDisplayValue(new Float32Array([1, 2]), new Float32Array([1, 2]))).toBe(true)
    expect(sameDisplayValue(new Float32Array([1, 2]), new Float32Array([1, 3]))).toBe(false)
    expect(sameDisplayValue(new Float32Array([1, 2]), new Float64Array([1, 2]))).toBe(false)
    expect(sameDisplayValue(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false)
    expect(sameDisplayValue(new Set([1, 2]), new Set([2, 1]))).toBe(true)
    expect(sameDisplayValue(new Set([1, 2]), new Set([1, 3]))).toBe(false)
    expect(sameDisplayValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(sameDisplayValue({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(sameDisplayValue({ a: 1 }, { b: 1 })).toBe(false)
    expect(sameDisplayValue(undefined, undefined)).toBe(true)
    expect(sameDisplayValue(null, undefined)).toBe(false)
    expect(sameDisplayValue(1, '1')).toBe(false)
  })

  it('mergeRecord returns the PREVIOUS record object when nothing moved', () => {
    const prev = { A: { column: 'c', categorical: true } }
    expect(mergeRecord(prev, { A: { column: 'c', categorical: true } })).toBe(prev)
    expect(mergeRecord(prev, { A: { column: 'd', categorical: true } })).not.toBe(prev)
    expect(mergeRecord(prev, {})).not.toBe(prev)
    expect(mergeRecord(prev, { A: { column: 'c', categorical: true }, B: { column: 'c', categorical: true } })).not.toBe(prev)
  })
})

describe('perCellRange — the NARROWING, not a hoist (DEC-13 keeps its home)', () => {
  it('selectPlotFilter resolves one plot and is unmoved by another plot’s range', () => {
    const store = createPlotInteractionStore()
    const selA = selectPlotFilter('plot-A')
    store.getState().setFilter('plot-A', [0, 5])
    const a0 = selA(store.getState())
    expect(a0).toEqual([0, 5])

    store.getState().setFilter('plot-B', [1, 2])
    expect(selA(store.getState())).toBe(a0) // A's identity survives B's write

    store.getState().setFilter('plot-A', [0, 6])
    expect(selA(store.getState())).not.toBe(a0)

    store.getState().clearFilter('plot-A')
    expect(selA(store.getState())).toBeUndefined()
  })
})

// ── NO MODULE SINGLETON (FIX_ROUND-1 / B2) ────────────────────────────────────────────────────────
// The store MUST be minted per `<GridWorkspace>` (`useState(createCellDisplayStore)`) because a
// popped-out container mounts a SECOND workspace inside the SAME `<Viz>`, and both instances end
// their recolor / legend effects with a WHOLE-RECORD `replaceColors` / `replaceLegend` over their own
// cells. The isolation test above proves the RULE holds for two stores that already exist; this
// proves the module offers no way to skip that step. `CellDisplay.store.ts` shipped
// `export const useCellDisplayStore = createCellDisplayStore()` — a process-global store with ZERO
// importers whose own doc-comment called it "the DEFAULT module-singleton store", i.e. an idiomatic
// import that would have silently wiped the main grid's colours from a pop-out. The sibling
// `PaneDocks.store.ts` exports no singleton, and neither may this one.
describe('CellDisplay.store — the module exports no shared store instance', () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../adapter/CellDisplay.store.ts'),
    'utf8',
  )

  it('the source was read at all (the scan is not vacuous)', () => {
    expect(SRC.length).toBeGreaterThan(5_000)
    expect(SRC).toContain('export function createCellDisplayStore(')
  })

  it('exports a FACTORY and never a constructed instance', () => {
    // Any `export const/let X = createCellDisplayStore(...)` at module scope is a process-global
    // store. Matched on the CALL, so a rename of the binding does not evade it.
    const singleton = /export\s+(?:const|let|var)\s+\w+(?:\s*:\s*[^=]+)?=\s*createCellDisplayStore\s*\(/
    expect(
      singleton.test(stripLineComments(SRC)),
      'CellDisplay.store.ts must not export a constructed store — one per <GridWorkspace>, reached through the ITEM-14 seam',
    ).toBe(false)
  })

  it('the sibling PaneDocks store does not export one either (the rule, not the instance)', () => {
    const paneDocks = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../adapter/PaneDocks.store.ts'),
      'utf8',
    )
    expect(paneDocks).toContain('export function createPaneDocksStore(')
    expect(
      /export\s+(?:const|let|var)\s+\w+(?:\s*:\s*[^=]+)?=\s*createPaneDocksStore\s*\(/.test(
        stripLineComments(paneDocks),
      ),
    ).toBe(false)
  })
})

/** Strip `//` line comments so a scan cannot match the PROSE that explains the ban — this file's
 *  own note quotes the deleted `export const useCellDisplayStore = createCellDisplayStore()` line
 *  verbatim, which is exactly the false-RED a comment-blind guard produces. */
function stripLineComments(src: string): string {
  return src
    .split('\n')
    .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n')
}

// @vitest-environment jsdom
//
// paneFrameWiring.test.tsx — #228 TEST-32. THE REAL RESOLVER, ON THE SHAPES PRODUCTION PRODUCES.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────
//
// Two blind audits, one after the other, landed on the same hole from different sides:
//
//   round 1 — "no test builds a `GridCell` the way the store does against a catalog keyed by
//              artifact id, i.e. nothing covers the only shape production produces";
//   round 2 — reverting the call site to `resolvePaneFrame(cat, cell.layoutId)`, which undoes the
//              ENTIRE production effect of the fix, left 1184 of 1184 tests green.
//
// Both are true of the same seam: `useGridData`'s `cellFrame`, which is the ONLY place
// `catalogForCell`, `layoutDrawnBy` and `resolvePaneFrame` are composed on the runtime path. The
// pieces were each unit-tested and the WIRING was not, and both hook suites stub `cellFrame`
// wholesale — so the composition had never once been executed.
//
// So this mounts the real hook against a source whose catalog looks like a host's (layouts keyed
// by ARTIFACT ID) and a cell that looks like the store's (`layoutId: 'primary'`, a sentinel), and
// asserts the frame it produces. That is the exact pair that made the binding inert in production
// while every test passed.

import { cleanup, render } from '@testing-library/react'
import { useMemo } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useGridData } from './useGridData'
import { createVizStores } from '../../adapter/vizStores'
import type { GridCell } from './gridModel'
import type { DataSource, DatasetCatalog, Positions } from '../data/wire'
import type { PaneFrame } from '../spatial/coordinateBinding'

const SPACE = 'visium:Visium_Mouse_Olfactory_Bulb'
/** what a HOST source keys its layouts by. Not a name — an id. */
const ARTIFACT_ID = '7c9f2a1e-0000-4000-8000-000000000001'
/** what the grid STORE mints. A sentinel, and nothing reconciles it against the catalog. */
const STORE_CELL: GridCell = { id: 'cell-1', kind: 'image', layoutId: 'primary' }

const N = 4
const POSITIONS = new Float32Array([1100, 2830, 3955, 4191, 6911, 8668, 2000, 5000])

function hostSource(over: Partial<DatasetCatalog> = {}): DataSource {
  const reject = (what: string) => () => Promise.reject(new Error(`${what} not used here`))
  return {
    async catalog(): Promise<DatasetCatalog> {
      return {
        datasetId: 'p1',
        pointCount: N,
        layouts: [{ id: ARTIFACT_ID, kind: 'layout', label: 'Spots', space: SPACE, toSpace: [1, 0, 0, 0, 1, 0] }],
        valueColumns: [],
        categoricalColumns: [],
        continuousColumns: [],
        hasImage: true,
        image: {
          width: 350,
          height: 450,
          channels: 4,
          affine: [0.05, 0, 0, 0, 0.05, 0],
          space: SPACE,
          toSpace: [5, 0, 0, 0, 5, 0],
        },
        ...over,
      }
    },
    async positions(): Promise<Positions> {
      return { positions: POSITIONS, length: N }
    },
    valueColumn: reject('valueColumn') as never,
    categorical: reject('categorical') as never,
    continuous: reject('continuous') as never,
    imageUnderlay: reject('imageUnderlay') as never,
    table: reject('table') as never,
    graph: reject('graph') as never,
  } as unknown as DataSource
}

function mountFrame(source: DataSource, cell: GridCell = STORE_CELL) {
  const holder: { frame?: PaneFrame } = {}
  function Probe() {
    // ONE store set for the life of the mount. Creating it in the render body gives every render a
    // fresh set, every `useStore` a fresh subscription, and React a re-render loop it caps with
    // "Maximum update depth exceeded" — which passes the assertions and poisons the run.
    const stores = useMemo(() => createVizStores(), [])
    const r = useGridData({
      stores,
      source,
      cells: [cell],
      denseCells: [cell],
      positionsProp: undefined,
      colorsProp: undefined,
      colorEpochProp: 0,
      catalogProp: undefined,
      pointIds: undefined,
    })
    holder.frame = r.cellFrame(cell)
    return null
  }
  render(<Probe />)
  return holder
}

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise(resolve => setTimeout(resolve, 5))
}

afterEach(cleanup)

describe('TEST-32 the real `cellFrame` binds a STORE-shaped cell to a HOST-shaped catalog', () => {
  it('resolves the frame the pane actually paints, not the sentinel it declares', async () => {
    const held = mountFrame(hostSource())
    await settle()

    const frame = held.frame!
    expect(frame.catalogResolved, 'the pull landed').toBe(true)
    // THE ASSERTION. `cell.layoutId` is `'primary'` and the catalog has no such layout; the frame
    // must still resolve, because the pane paints the layout the owned pull read. Reverting the
    // call site to `cell.layoutId` makes this `undefined` and the binding refuse — which is
    // exactly what production did, silently, before the fix.
    expect(frame.layoutSpace).toBe(SPACE)
    expect(frame.imageSpace).toBe(SPACE)
    expect(frame.binding.bound).toBe(true)
    // …and the placements the layers will use, by value.
    expect(frame.imageMatrix?.[0]).toBe(5)
    expect(frame.layoutToSpace).toEqual([1, 0, 0, 0, 1, 0])
  })

  it('and REFUSES when the two declared spaces differ — the same wiring, the other answer', async () => {
    // The control that makes the case above mean "bound because the ids match" rather than
    // "bound because this code path always binds".
    const held = mountFrame(
      hostSource({
        layouts: [
          { id: ARTIFACT_ID, kind: 'layout', label: 'Spots', space: `${SPACE}__sectionB`, toSpace: [1, 0, 0, 0, 1, 0] },
        ],
      }),
    )
    await settle()
    expect(held.frame!.catalogResolved).toBe(true)
    expect(held.frame!.layoutSpace).toBe(`${SPACE}__sectionB`)
    expect(held.frame!.binding.bound).toBe(false)
  })

  // NOT COVERED HERE, deliberately: the MULTI-DATASET arm. Driving it needs a `DatasetResolver`
  // installed on the store, and mounting one without it makes the acquire reject into an
  // unhandled rejection — noise that would sit in this suite forever. The rule itself
  // (a multi-dataset cell's DECLARED layout is the one it paints, because `cellData` reads
  // `positionsByLayout[cell.layoutId]`) is pinned by TEST-24 against `layoutDrawnBy` directly.
  // Stated rather than left as a silent gap.
})

// ── TEST-36 — a FAILED workspace pull is terminal for a DEFAULT cell, and only for it ────────

describe('TEST-36 the terminal arm does not swallow a still-loading dataset pane', () => {
  const failing: DataSource = {
    catalog: () => Promise.reject(new Error('the control plane blinked')),
    positions: () => Promise.reject(new Error('never reached')),
  } as unknown as DataSource

  it('a DEFAULT cell resolves to an EMPTY frame — nothing will ever be declared for it', async () => {
    // Without a terminal arm, `catalog` stays null forever after a rejection and
    // `catalogResolved` stays false — so an image pane with a caller-supplied `loader` never gets
    // a camera at all. "Resolved and empty" is the honest state: the pull failed and will not be
    // retried by this hook.
    const held = mountFrame(failing)
    await settle()
    expect(held.frame!.catalogResolved).toBe(true)
    expect(held.frame!.binding.bound).toBe(false)
  })

  it('a MULTI-DATASET cell keeps waiting — its catalog comes from somewhere else entirely', async () => {
    // `ownedError` is the WORKSPACE pull's failure. A cell with a `datasetId` gets its catalog
    // from the dataset store, and while THAT is loading `cat` is also null — so an unscoped
    // terminal arm marks this pane resolved-and-empty and seeds its camera in pixel units, which
    // the idempotent-once rule then makes permanent. Deleting or unscoping the arm both SURVIVED
    // the suite before this pair existed.
    const held = mountFrame(failing, { id: 'cell-2', kind: 'image', layoutId: 'x', datasetId: 'dsB' })
    await settle()
    expect(held.frame!.catalogResolved).toBe(false)
  })
})

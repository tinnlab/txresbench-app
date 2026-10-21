// ownedData.test.ts — the data-ownership-inversion PULL (`useGridData.pullOwnedData`).
//
// ── The defect this exists to keep dead ──────────────────────────────────────────────
//
// The pull read its point positions from `catalog.layouts[0]?.id ?? 'primary'`. That `??` is not a
// fallback, it is a GUESS at another module's vocabulary: `'primary'` is what the in-package
// fixtures and the grid store call their default layout, while a host source addresses layouts by
// artifact id. So a source whose catalog declared NO layout — a project with no embedding artifact,
// i.e. every freshly imported dataset — was asked for an artifact literally named `primary`. The
// real host source rejected (`GET /api/artifacts/primary` → 400, not a UUID), the pull's rejection
// latched `ownedError`, and the workspace covered ITSELF in "Failed to load visualization data from
// the source" — over a canvas of violin cells that need no positions at all and were otherwise
// ready to paint.
//
// The property: EMPTY and FAILED are different. A source with no declared layout has no dense
// substrate, and the honest result is zero points with no error. A DECLARED layout that then fails
// to read is a real failure and must still reject — the third case is the negative control that
// stops the fix from degenerating into "swallow every positions error".
//
// The fake sources are the real wire contract (`DataSource`), so this drives the actual pull rather
// than a re-implementation of it.

import { describe, it, expect } from 'vitest'
import { pullOwnedData } from './useGridData'
import type {
  CategoricalColumn,
  ContinuousColumn,
  DataSource,
  DatasetCatalog,
  DataTable,
  GraphData,
  ImageUnderlay,
  Positions,
  SparseColumn,
} from '../data/wire'

function catalogWith(over: Partial<DatasetCatalog> = {}): DatasetCatalog {
  return {
    datasetId: 'test',
    pointCount: 3,
    layouts: [],
    valueColumns: [],
    categoricalColumns: [],
    continuousColumns: [],
    hasImage: false,
    ...over,
  }
}

/** A `DataSource` that COUNTS its reads, so "never asked" is assertable rather than inferred. */
class ProbeSource implements DataSource {
  readonly positionsCalls: string[] = []
  constructor(
    private readonly cat: DatasetCatalog,
    /** what `positions()` does when it IS called. */
    private readonly onPositions: (layoutId: string) => Promise<Positions> = async () => ({
      positions: new Float32Array([0, 0, 1, 1, 2, 2]),
      length: 3,
    }),
  ) {}
  async catalog(): Promise<DatasetCatalog> {
    return this.cat
  }
  async positions(layoutId: string): Promise<Positions> {
    this.positionsCalls.push(layoutId)
    return this.onPositions(layoutId)
  }
  async valueColumn(): Promise<SparseColumn> {
    throw new Error('no value columns')
  }
  /** Declares the `DataSource` parameter it is given (`wire.ts`: `categorical(key, opts?)`).
   *  `implements` lets a method DROP parameters, so the zero-arg form type-checked here — but
   *  it made the base's own type `() => Promise<CategoricalColumn>`, which no subclass that
   *  actually reads the key can override (TS2416 on `UngroupedSource` below). Nothing ran
   *  `tsc` over this file, so the base drifted away from the interface it implements (#276). */
  async categorical(_key: string): Promise<CategoricalColumn> {
    throw new Error('no categorical columns')
  }
  async continuous(): Promise<ContinuousColumn> {
    throw new Error('no continuous columns')
  }
  async table(): Promise<DataTable> {
    return { rowLabels: [], columns: {} }
  }
  async graph(): Promise<GraphData> {
    return { nodeKey: '', paths: [] }
  }
  async imageUnderlay(): Promise<ImageUnderlay> {
    throw new Error('no image underlay')
  }
}

describe('owned pull — a source that declares no layout', () => {
  it('never asks the source for positions, and lands ZERO points rather than an error', async () => {
    // The shape of a freshly-imported project: real columns, no embedding ⇒ no declared layout.
    const source = new ProbeSource(
      catalogWith({
        continuousColumns: [{ id: 'a1#values', kind: 'continuous', label: 'total_counts' }],
      }),
      async layoutId => {
        // Stands in for the host source's 400: an id it never declared cannot resolve.
        throw new Error(`Cannot parse \`id\` with value \`${layoutId}\``)
      },
    )

    const owned = await pullOwnedData({ source, catalogProp: null, needsBuffers: true })

    expect(
      source.positionsCalls,
      'the pull invented a layout id the source never declared',
    ).toEqual([])
    expect(owned.positions).toBeInstanceOf(Float32Array)
    expect(owned.positions).toHaveLength(0)
    expect(owned.colors).toHaveLength(0)
    expect(owned.catalog.continuousColumns).toHaveLength(1)
  })

  it('the chart cells still get their catalog — the workspace is usable, not blank', async () => {
    const source = new ProbeSource(
      catalogWith({
        categoricalColumns: [{ id: 'g', kind: 'categorical', label: 'group' }],
      }),
    )
    const owned = await pullOwnedData({ source, catalogProp: null, needsBuffers: true })
    expect(owned.catalog.categoricalColumns.map(c => c.id)).toEqual(['g'])
  })
})

describe('owned pull — a source that DOES declare a layout', () => {
  it('reads the SOLE declared layout, by its own id', async () => {
    // The surviving half of the original assertion: the id comes from the CATALOG, not from a
    // literal. (The `?? 'primary'` guess this file removed is what that pinned.)
    const source = new ProbeSource(
      catalogWith({
        layouts: [{ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', kind: 'layout', label: 'UMAP' }],
      }),
    )

    const owned = await pullOwnedData({ source, catalogProp: null, needsBuffers: true })

    expect(source.positionsCalls).toEqual(['f47ac10b-58cc-4372-a567-0e02b2c3d479'])
    expect(owned.positions).toHaveLength(6)
  })

  it('several layouts with no declaration: still the FIRST — reported, not refused (F10)', async () => {
    // This test was `reads the FIRST declared layout, by its own id` and it certified `layouts[0]`.
    // It was briefly rewritten to require a REFUSAL, and two independent blind reviews called that
    // a regression: a catalog with a UMAP and a t-SNE is the ORDINARY single-cell catalog, there is
    // no UI anywhere to choose a cell's `layoutId`, and this is not the chart-binding seam — so
    // refusing here is a permanently blank canvas, with no message and no recovery. That is the
    // declare-and-MIGRATE shape a prior lifecycle already ruled on for the canvas's own
    // `cat.layouts[0]`: the guess ends when there is a way to declare the answer.
    //
    // So it is pinned as WHAT IT IS, with the reason, rather than quietly left unasserted. What
    // this file's change DID buy is the line below it: the id comes from the CATALOG, never from
    // the literal `'primary'` this module used to fall back to.
    const source = new ProbeSource(
      catalogWith({
        layouts: [
          { id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', kind: 'layout', label: 'UMAP' },
          { id: 'second', kind: 'layout', label: 'tSNE' },
        ],
      }),
    )

    const owned = await pullOwnedData({ source, catalogProp: null, needsBuffers: true })

    expect(source.positionsCalls).toEqual(['f47ac10b-58cc-4372-a567-0e02b2c3d479'])
    // …and whatever it asked for, it asked for a layout the CATALOG DECLARED — the property the
    // removal of `?? 'primary'` actually bought, and the one that must not regress.
    expect(owned.catalog.layouts.map(l => l.id)).toContain(source.positionsCalls[0])
  })

  // NEGATIVE CONTROL. Without this, "no layout ⇒ no error" could be satisfied by swallowing every
  // positions failure — which would replace a visible error with a silently blank canvas, strictly
  // worse than the defect being fixed.
  it('a DECLARED layout that fails to read still REJECTS, so the error surface fires', async () => {
    const boom = new Error('layout "u1": 7 bytes are not f32-aligned')
    const source = new ProbeSource(
      catalogWith({ layouts: [{ id: 'u1', kind: 'layout', label: 'UMAP' }] }),
      async () => {
        throw boom
      },
    )

    await expect(pullOwnedData({ source, catalogProp: null, needsBuffers: true })).rejects.toThrow(
      '7 bytes are not f32-aligned',
    )
    expect(source.positionsCalls).toEqual(['u1'])
  })

  it('a failed DEFAULT COLORING degrades to full-length neutral gray, not to an error', async () => {
    // `ProbeSource.categorical/continuous` throw, so `computeColoring` cannot resolve the default
    // color-by — the pre-existing best-effort contract, preserved.
    const source = new ProbeSource(catalogWith({ layouts: [{ id: 'u1', kind: 'layout', label: 'UMAP' }] }))

    const owned = await pullOwnedData({ source, catalogProp: null, needsBuffers: true })

    expect(owned.positions).toHaveLength(6)
    // 3 points × RGBA — a 0-length colors buffer against N positions is a deck.gl length mismatch.
    expect(owned.colors).toHaveLength(12)
    expect([...owned.colors!.slice(0, 4)]).toEqual([160, 160, 160, 255])
  })
})

describe('owned pull — the catalog-only path', () => {
  it('a caller that passed its own buffers reads NO positions at all', async () => {
    const source = new ProbeSource(catalogWith({ layouts: [{ id: 'u1', kind: 'layout', label: 'UMAP' }] }))

    const owned = await pullOwnedData({ source, catalogProp: null, needsBuffers: false })

    expect(source.positionsCalls).toEqual([])
    expect(owned.positions).toBeNull()
    expect(owned.colors).toBeNull()
    expect(owned.catalog.layouts).toHaveLength(1)
  })

  it('a caller-supplied catalog is used verbatim — the source is not re-read', async () => {
    let catalogReads = 0
    const cat = catalogWith({ layouts: [{ id: 'u1', kind: 'layout', label: 'UMAP' }] })
    class CountingSource extends ProbeSource {
      override async catalog(): Promise<DatasetCatalog> {
        catalogReads++
        return cat
      }
    }
    const counting = new CountingSource(cat)

    const owned = await pullOwnedData({ source: counting, catalogProp: cat, needsBuffers: true })

    expect(catalogReads).toBe(0)
    expect(owned.catalog).toBe(cat)
  })
})

// ── the workspace default must not paint a whole canvas BLACK ────────────────────────────────
//
// The default color buffer came from `computeColoring(source, DEFAULT_COLOR_BY)`, and
// `DEFAULT_COLOR_BY` is `{ mode: 'categorical', key: 'group' }` — a hardcoded GUESS at another
// module's column name, exactly like the `?? 'primary'` layout guess this file already exists to
// keep dead. It only ever looked right because the in-package fixtures happen to call their
// grouping column `group`.
//
// A source that does NOT have that column answers in one of two ways, and BOTH were wrong:
//
//   • it THROWS (the host source rejects a key it cannot address) → caught → neutral gray. Fine.
//   • it RETURNS ONE UNGROUPED COLUMN for an unknown key — the frame-backed canvas source does
//     exactly this, deliberately, because "group these rows by nothing" is a real answer. That
//     single synthetic category then takes palette slot 0, and slot 0 of Okabe-Ito is [0,0,0]:
//     BLACK. Every point on the canvas, painted black, with a legend claiming a category called
//     "All". MEASURED before this fix: first RGBA [0,0,0,255], all points identical.
//
// Black-on-black is the same disease as the rest of this area — an unresolved binding producing a
// confident-looking answer instead of saying it has nothing. The right default for "no colour-by
// has been chosen and the catalog cannot serve the default one" is the NEUTRAL buffer this module
// already defines for the failure case: one flat, legible, theme-independent gray that reads as
// "uncoloured", which is the truth. It is not a palette slot, so it never collides with a real
// category-0, and it never claims a category that does not exist.
//
// The guess is gone rather than patched: the key is checked against the CATALOG, so a source that
// genuinely publishes the default column still colours by it (fixtures + stories byte-identical).
describe('owned pull — the DEFAULT coloring never guesses a column name', () => {
  /** A source in the shape of the frame-backed canvas source: an unknown categorical key is not an
   *  error, it is ONE group over every row (what "ungrouped" means). */
  class UngroupedSource extends ProbeSource {
    readonly categoricalCalls: string[] = []
    async categorical(key: string): Promise<CategoricalColumn> {
      this.categoricalCalls.push(key)
      return { codes: new Uint16Array(3), categories: ['All'], length: 3 }
    }
  }

  it('a frame with NO default color-by column paints NEUTRAL, and is never asked for it', async () => {
    const source = new UngroupedSource(
      catalogWith({
        layouts: [{ id: 'emb', kind: 'layout', label: 'Embedding' }],
        continuousColumns: [{ id: 'a1#values', kind: 'continuous', label: 'depth' }],
      }),
    )
    const owned = await pullOwnedData({ source, catalogProp: null, needsBuffers: true })
    const colors = owned.colors!
    expect(
      Array.from(colors.slice(0, 4)),
      'a canvas with no grouping column must not be painted palette-slot-0 black',
    ).toEqual([160, 160, 160, 255])
    // every point, not just the first — the failure was uniform, so the assertion must be too.
    for (let i = 0; i < 3; i++) expect(Array.from(colors.slice(i * 4, i * 4 + 4))).toEqual([160, 160, 160, 255])
    expect(
      source.categoricalCalls,
      'the catalog cannot serve the default key, so the source is never asked for it',
    ).toEqual([])
  })

  it('a frame that DOES publish the default column is still coloured by it (the control)', async () => {
    const source = new UngroupedSource(
      catalogWith({
        layouts: [{ id: 'emb', kind: 'layout', label: 'Embedding' }],
        categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Group' }],
      }),
    )
    const owned = await pullOwnedData({ source, catalogProp: null, needsBuffers: true })
    expect(source.categoricalCalls).toEqual(['group'])
    // a real single-category column still gets its palette color — this fix narrows WHEN the
    // default coloring runs, never what `categoricalColors` does once it does.
    expect(Array.from(owned.colors!.slice(0, 4))).toEqual([0, 0, 0, 255])
  })
})

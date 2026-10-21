import { describe, it, expect } from 'vitest'
import {
  datasetAxisLabels,
  datasetLinkKey,
  resolveLinkedCellDomains,
  sourceForCell,
  catalogForCell,
  layoutDrawnBy,
  effectiveLoaderFor,
  paneRasterPresent,
  type CellColorDomain,
} from './gridModel'
import { resolvePaneFrame } from '../spatial/coordinateBinding'
import { pullOwnedData } from './useGridData'
import type { DatasetCatalog } from '../data/wire'

// ---------------------------------------------------------------------------
// MD-9 (ITEM-9): a multi-dataset cell's colorBy is computed from ITS dataset's source, not the
// default one — the pure decisions that drive the `perCellColors` effect: which source a cell
// fetches from, and how the linked color-scale domain is scoped per dataset. MD-8 (ITEM-8): the
// per-dataset tooltip axis-label fallback.
// ---------------------------------------------------------------------------

// A tiny stand-in for a resolved DataSource — the effect only needs identity here (which source a
// cell would call `.categorical`/`.continuous` on); the real fetch is exercised by the e2e.
type FakeSource = { readonly name: string }

describe('sourceForCell — MD-9 per-cell colorBy source selection', () => {
  const workspace: FakeSource = { name: 'default' }
  const sourcesById: Record<string, FakeSource> = {
    dsA: { name: 'A' },
    dsB: { name: 'B' },
  }
  const lookup = (id: string): FakeSource | null => sourcesById[id] ?? null

  it('a DEFAULT cell (no datasetId) fetches from the workspace source', () => {
    expect(sourceForCell(undefined, workspace, lookup)).toBe(workspace)
    expect(sourceForCell(null, workspace, lookup)).toBe(workspace)
  })

  it("a multi-dataset cell fetches from ITS OWN dataset's source (a B-only column resolves against B)", () => {
    expect(sourceForCell('dsA', workspace, lookup)).toBe(sourcesById.dsA)
    expect(sourceForCell('dsB', workspace, lookup)).toBe(sourcesById.dsB)
    // crucially NOT the default source — that is the bug MD-9 fixes (would throw on a B-only column).
    expect(sourceForCell('dsB', workspace, lookup)).not.toBe(workspace)
  })

  it('a datasetId whose source is not resolved yet returns null (caller skips + recolors when ready)', () => {
    expect(sourceForCell('dsMissing', workspace, lookup)).toBeNull()
  })
})

describe('datasetLinkKey — MD-9 per-dataset shared-domain scoping', () => {
  it('scopes the union key by dataset so cross-dataset same-name columns are distinct', () => {
    expect(datasetLinkKey('dsA', 'qc')).toBe('dsA::qc')
    expect(datasetLinkKey('dsB', 'qc')).toBe('dsB::qc')
    expect(datasetLinkKey('dsA', 'qc')).not.toBe(datasetLinkKey('dsB', 'qc'))
  })

  it('default cells collapse to the empty-prefix key (byte-identical to the pre-MD bare key)', () => {
    expect(datasetLinkKey(undefined, 'qc')).toBe('::qc')
    expect(datasetLinkKey(null, 'qc')).toBe('::qc')
  })

  it('feeding dataset-scoped keys into resolveLinkedCellDomains isolates cross-dataset series', () => {
    const cells: CellColorDomain[] = [
      { id: 'a', key: datasetLinkKey('dsA', 'expr'), domain: [0, 5], linked: true },
      { id: 'b', key: datasetLinkKey('dsB', 'expr'), domain: [10, 30], linked: true },
    ]
    const eff = resolveLinkedCellDomains(cells)
    // no union across datasets — B's high domain never widens A's colormap.
    expect(eff['a']).toEqual([0, 5])
    expect(eff['b']).toEqual([10, 30])
  })
})

describe('datasetAxisLabels — MD-8 per-dataset tooltip fallback labels', () => {
  const catalog: DatasetCatalog = {
    datasetId: 'dsB',
    pointCount: 100,
    layouts: [
      { id: 'umap', kind: 'layout', label: 'UMAP' },
      { id: 'pca', kind: 'layout', label: 'PCA' },
    ],
    valueColumns: [],
    categoricalColumns: [],
    continuousColumns: [],
    hasImage: false,
  }

  it("names the x/y rows after the cell's catalog LAYOUT", () => {
    expect(datasetAxisLabels(catalog, 'umap')).toEqual({ x: 'UMAP x', y: 'UMAP y' })
    expect(datasetAxisLabels(catalog, 'pca')).toEqual({ x: 'PCA x', y: 'PCA y' })
  })

  it('returns undefined for an unknown layout or a missing catalog (⇒ plain x / y default)', () => {
    expect(datasetAxisLabels(catalog, 'tsne')).toBeUndefined()
    expect(datasetAxisLabels(null, 'umap')).toBeUndefined()
    expect(datasetAxisLabels(undefined, 'umap')).toBeUndefined()
  })
})

// ── #228 TEST-10 — the same question, asked of the CATALOG ─────────────────────────────────────

describe('TEST-10 catalogForCell — a cell reads ITS dataset`s declared frame, never the default`s', () => {
  const IDENTITY = [1, 0, 0, 0, 1, 0] as readonly [number, number, number, number, number, number]
  const defaultCatalog = {
    layouts: [{ id: 'coords', space: 'S1' }],
    image: { space: 'S1', toSpace: [5, 0, 0, 0, 5, 0], affine: IDENTITY },
  }
  const dsB = {
    layouts: [{ id: 'coords', space: 'S2' }],
    image: { space: 'S2', toSpace: [2, 0, 0, 0, 2, 0], affine: IDENTITY },
  }
  const byId: Record<string, typeof dsB> = { dsB }
  const lookup = (id: string) => byId[id] ?? null

  it('a cell with no datasetId takes the workspace catalog', () => {
    expect(catalogForCell(undefined, defaultCatalog, lookup)).toBe(defaultCatalog)
    expect(catalogForCell(null, defaultCatalog, lookup)).toBe(defaultCatalog)
  })

  it('a multi-dataset cell takes ITS OWN catalog, which declares a DIFFERENT space', () => {
    // This is the multi-dataset shape of the #228 defect: reading the default dataset's
    // `coordinate_space` while rendering another dataset's raster binds two artifacts that were
    // never in one frame, and the overlay is plausible and wrong.
    expect(catalogForCell('dsB', defaultCatalog, lookup)).toBe(dsB)
    expect(catalogForCell('dsB', defaultCatalog, lookup)).not.toBe(defaultCatalog)
    const frame = resolvePaneFrame(catalogForCell('dsB', defaultCatalog, lookup), 'coords')
    expect(frame.imageSpace).toBe('S2')
    expect(frame.layoutSpace).toBe('S2')
  })

  it('an UNRESOLVED dataset yields null — and a null catalog is a REFUSAL, not a fallback', () => {
    expect(catalogForCell('dsMissing', defaultCatalog, lookup)).toBeNull()
    const frame = resolvePaneFrame(catalogForCell('dsMissing', defaultCatalog, lookup), 'coords')
    expect(frame.binding.bound).toBe(false)
    expect(frame.binding.bound ? '' : frame.binding.reason).toContain('has not been read')
  })
})

// ── #228 TEST-24 — the layout a cell actually DRAWS ───────────────────────────────────────────

describe('TEST-24 layoutDrawnBy — the binding is decided on what is PAINTED, not what is declared', () => {
  // ── THE DEFECT THIS EXISTS FOR, FOUND BY A BLIND DESIGN-CONFORMANCE AUDIT ───────────────────
  //
  // A cell minted by the grid STORE carries the sentinel `layoutId: 'primary'`
  // (`GridWorkspace.store.ts`'s `DEFAULT_LAYOUT_ID`), and the production canvas mounts
  // `<GridWorkspace source>` with NO option, so nothing reconciles it. A host `DataSource` keys
  // its layouts by ARTIFACT ID. So a frame resolved by `cell.layoutId` found NOTHING on every
  // real project — a permanent, silent refusal that looks exactly like two artifacts being in
  // different spaces. The whole binding was inert in production and every test passed, because
  // every test handed the resolver a catalog whose only layout id was the one it then asked for.
  const artifactId = '7c9f2a1e-0000-4000-8000-000000000001'
  const hostCatalog = { layouts: [{ id: artifactId }] }
  /** the shape the STORE mints — the id is a sentinel, not a reference. */
  const storeCell = { layoutId: 'primary' as const }

  it('a store-minted cell over a HOST catalog resolves the layout the PULL read, not the sentinel', () => {
    expect(layoutDrawnBy(storeCell, hostCatalog, artifactId)).toBe(artifactId)
    expect(layoutDrawnBy(storeCell, hostCatalog, artifactId)).not.toBe('primary')
  })

  it('a DECLARED layout does NOT win for an owned default cell — the pull ignores it', () => {
    // A second blind audit caught the first version of this case asserting the defect. For a
    // DEFAULT cell `cellData` returns the WORKSPACE buffers, and `pullOwnedData` reads ONE layout
    // without ever consulting `cell.layoutId`. So a cell whose `encode.layout` names a different
    // but perfectly real catalog layout paints the PULLED one — and binding on the declared id
    // would decide the frame from artifact B while drawing artifact A's positions, which is the
    // "UMAP drawn on tissue" this whole function exists to make impossible.
    const two = { layouts: [{ id: 'layout-a' }, { id: 'layout-b' }] }
    expect(layoutDrawnBy({ layoutId: 'layout-b' }, two, 'layout-a')).toBe('layout-a')
    expect(layoutDrawnBy({ layoutId: 'layout-b' }, two, 'layout-a')).not.toBe('layout-b')
  })

  it('a default cell that declares an ABSENT layout also takes the pulled one', () => {
    const two = { layouts: [{ id: 'layout-a' }, { id: 'layout-b' }] }
    expect(layoutDrawnBy({ layoutId: 'primary' }, two, 'layout-a')).toBe('layout-a')
  })

  it('a MULTI-DATASET cell draws its own declared layout, so that is what binds', () => {
    // `cellData`'s dataset branch reads `positionsByLayout[cell.layoutId]` — here the declared id
    // IS the drawn one, and the rule above must not override it.
    const two = { layouts: [{ id: 'layout-a' }, { id: 'layout-b' }] }
    expect(layoutDrawnBy({ datasetId: 'dsB', layoutId: 'layout-b' }, two, 'layout-a')).toBe('layout-b')
    expect(layoutDrawnBy({ datasetId: 'dsB', layoutId: 'not-in-catalog' }, two, 'layout-a')).toBe(
      'not-in-catalog',
    )
  })

  it('a CALLER-supplied buffer means no layout was read — the declaration is all there is', () => {
    // The `@internal` gallery/test path passes `positions` directly; no catalog entry describes
    // them, so `OwnedData.layoutId` is `null` and there is nothing to prefer over the cell's own.
    const two = { layouts: [{ id: 'layout-a' }, { id: 'layout-b' }] }
    expect(layoutDrawnBy({ layoutId: 'primary' }, two, null)).toBe('primary')
  })

  it('no catalog at all ⇒ the cell`s own id, and the frame then refuses on `catalogResolved`', () => {
    expect(layoutDrawnBy(storeCell, null, null)).toBe('primary')
    expect(resolvePaneFrame(null, layoutDrawnBy(storeCell, null, null)).catalogResolved).toBe(false)
  })
})

// ── #228 TEST-29 — which loader a pane renders from ──────────────────────────────────────────

describe('TEST-29 effectiveLoaderFor — a CALLER-supplied loader wins over the fetched entry', () => {
  const level = { shape: [1, 4, 4], labels: ['c', 'y', 'x'] } as never
  const other = { shape: [1, 8, 8], labels: ['c', 'y', 'x'] } as never

  it('prefers `cell.loader`, which is what the emit does — one rule, two readers', () => {
    // The emit and the camera-framing effect both ask this question, and they must not answer it
    // differently: the emit's `cell.loader ?? entry?.loader` places the raster by the FULL-
    // RESOLUTION affine, so a camera that resolved a different loader would frame a different
    // grid. Inverting the precedence here SURVIVED the suite before this case existed.
    expect(effectiveLoaderFor({ loader: [level] }, { loader: [other] } as never)).toEqual([level])
    expect(effectiveLoaderFor({ loader: undefined }, { loader: [other] } as never)).toEqual([other])
  })

  it('an unresolved, absent or EMPTY pyramid is null, not an empty array', () => {
    // `length === 0` is a resolved-but-unusable loader (`imagePixelSource()` returning nothing),
    // and the emit treats it as no raster; a caller that got `[]` back and truthiness-tested it
    // would draw an image layer over no levels.
    expect(effectiveLoaderFor({ loader: undefined }, 'loading')).toBeNull()
    expect(effectiveLoaderFor({ loader: undefined }, null)).toBeNull()
    expect(effectiveLoaderFor({ loader: undefined }, undefined)).toBeNull()
    expect(effectiveLoaderFor({ loader: [] }, null)).toBeNull()
    expect(effectiveLoaderFor({ loader: undefined }, { loader: [] } as never)).toBeNull()
  })
})

// ── #228 TEST-37 — what `OwnedData.layoutId` MEANS ───────────────────────────────────────────

describe('TEST-37 the pull reports the layout it read, and the frame follows it', () => {
  it('a MULTI-layout catalog makes the reported id observable', () => {
    // Every catalog fixture elsewhere has exactly ONE layout, which makes `OwnedData.layoutId`'s
    // meaning untestable by construction: reporting the wrong one is indistinguishable from
    // reporting the right one. Two layouts is the smallest fixture where it is not.
    const two = { layouts: [{ id: 'layout-a', space: 'S1' }, { id: 'layout-b', space: 'S2' }] }
    const cell = { layoutId: 'primary' }
    // Whichever id the pull reports is the one the frame resolves against — so a pull that
    // reported `layout-b` while reading `layout-a` would bind the WRONG artifact's space, which
    // is the whole failure this parameter exists to make impossible.
    expect(resolvePaneFrame(two, layoutDrawnBy(cell, two, 'layout-a')).layoutSpace).toBe('S1')
    expect(resolvePaneFrame(two, layoutDrawnBy(cell, two, 'layout-b')).layoutSpace).toBe('S2')
  })
})

// ── #228 TEST-40 — `paneRasterPresent`, the decision two modules share ───────────────────────

describe('TEST-40 paneRasterPresent — `loading` is "not yet", not "no raster"', () => {
  const level = { shape: [1, 4, 4], labels: ['c', 'y', 'x'] } as never
  const tex = { texture: {} as never, width: 4, height: 4 }

  it('a pane mid-FETCH has a raster coming — the emit waits and the reporter stays quiet', () => {
    // Treating `'loading'` as "no raster" makes the emit refuse a pane that is about to draw and
    // the reporter explain an absence that is a millisecond old — a line in the console of every
    // ordinary project on every open. Dropping the `'loading'` check SURVIVED the suite before
    // this case existed, because every other fixture is already settled.
    expect(paneRasterPresent({ loader: undefined }, undefined, 'loading', false)).toBe(false)
    expect(paneRasterPresent({ loader: undefined }, undefined, tex, false)).toBe(true)
    expect(paneRasterPresent({ loader: undefined }, undefined, null, false)).toBe(false)
  })

  it('a usable placement is required for the single-texture path, and never for the tiled one', () => {
    // The fallback needs its served-level affine to be invertible; the tiled path has its own
    // `to_space` and is unaffected by a fault in the other path's number.
    expect(paneRasterPresent({ loader: undefined }, undefined, tex, true)).toBe(false)
    expect(paneRasterPresent({ loader: [level] }, undefined, tex, true)).toBe(true)
    expect(paneRasterPresent({ loader: undefined }, { loader: [level] } as never, undefined, true)).toBe(true)
  })
})

// ── #228 TEST-41 — the pull REPORTS the layout it read ───────────────────────────────────────

describe('TEST-41 pullOwnedData names the layout its positions came from', () => {
  const layouts = [
    { id: 'layout-a', kind: 'layout' as const, label: 'A' },
    { id: 'layout-b', kind: 'layout' as const, label: 'B' },
  ]
  const catalog = {
    datasetId: 'd',
    pointCount: 2,
    layouts,
    valueColumns: [],
    categoricalColumns: [],
    continuousColumns: [],
    hasImage: false,
  }

  it('reports the id it actually read, on a MULTI-layout catalog', async () => {
    // Every other catalog fixture has exactly ONE layout, which makes this field's meaning
    // untestable by construction: reporting the wrong id is indistinguishable from the right one.
    // And the FRAME resolves against whatever is reported, so a pull that read `layout-a` and
    // reported `layout-b` binds the wrong artifact's coordinate space.
    const read: string[] = []
    const source = {
      catalog: async () => catalog,
      positions: async (id: string) => {
        read.push(id)
        return { positions: new Float32Array([0, 0, 1, 1]), length: 2 }
      },
      continuous: async () => {
        throw new Error('no default colouring here')
      },
    } as unknown as Parameters<typeof pullOwnedData>[0]['source']

    const owned = await pullOwnedData({ source, catalogProp: null, needsBuffers: true })
    expect(read, 'the pull read exactly one layout').toHaveLength(1)
    expect(owned.layoutId, 'and named THAT one').toBe(read[0])
  })

  it('reports null when the caller supplied the buffers — no layout was read', async () => {
    const source = {
      catalog: async () => catalog,
      positions: async () => {
        throw new Error('must not be read')
      },
    } as unknown as Parameters<typeof pullOwnedData>[0]['source']
    const owned = await pullOwnedData({ source, catalogProp: null, needsBuffers: false })
    expect(owned.layoutId).toBeNull()
  })
})

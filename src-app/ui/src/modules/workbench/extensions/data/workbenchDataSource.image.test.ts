// workbenchDataSource.image.test.ts — #159 TEST-13, TEST-14.
//
// The raster channel on the production pull source: where its two facts come from, how often it
// opens the file, and what a project's catalog looks like when the raster will not open.
//
// Only the control-plane and transport boundaries are injected; the reader that runs is the
// shipped one, over a REAL emitted `.ome.tif`, so the pixels and the level table are real.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@txresbench/kit', () => ({
  message: { info: () => {}, success: () => {}, error: () => {} },
}))

import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  NotReachableError,
  WorkbenchDataSource,
  type DataPlaneArtifact,
  type WorkbenchDataSourceDeps,
} from './workbenchDataSource'

const SLOW = 120_000
const FIXTURES = path.resolve(process.cwd(), '../libs/viz/src/viz-core/spatial/fixtures')
const RASTER_BYTES = readFileSync(path.join(FIXTURES, 'spatial-image-hires.ome.tif'))

const EMITTED = JSON.parse(
  readFileSync(path.join(FIXTURES, 'emitted-manifest-entries.json'), 'utf8'),
) as { id: string; structure: unknown; meta: { to_space: number[]; coordinate_space: string } }[]
const HIRES = EMITTED.find(e => e.id === 'spatial-image-hires')!

/**
 * The entity-axis name a coordinates artifact declares, READ FROM THE FIXTURE rather than typed.
 *
 * Same reason the datatype ids above are read from `emitted-manifest-entries.json`: the app must
 * carry ZERO of the domain lattice (`lint-no-domain-in-builtin`), and an axis name is part of it.
 * The fixture is a producer-derived data file outside the linted roots, so naming the axis there
 * and reading it here keeps the vocabulary where it belongs — in the data.
 */
const ENTITY_AXIS = (
  JSON.parse(readFileSync(path.join(FIXTURES, 'vendor-spot-positions.json'), 'utf8')) as {
    entity_axis: string
  }
).entity_axis

/** One raster row, for the cases that build a source by hand rather than through `probe`. */
const RASTER_ROW_FOR_RETRY: DataPlaneArtifact = {
  id: 'r1',
  datatype: 'nobody/has-ever-registered-this',
  structure: HIRES.structure,
  meta: HIRES.meta,
  stored_bytes: RASTER_BYTES.byteLength,
}

async function realPyramid() {
  const { loadOmeTiffPyramid } = await import('@txresbench/viz/core')
  return loadOmeTiffPyramid({
    byteLength: RASTER_BYTES.byteLength,
    async read(start: number, end: number) {
      return RASTER_BYTES.buffer.slice(
        RASTER_BYTES.byteOffset + start,
        RASTER_BYTES.byteOffset + end + 1,
      )
    },
  })
}

interface Build {
  /** what the LISTING says about the raster row (the catalog hop) */
  listed?: Partial<DataPlaneArtifact>
  /** what the SINGLE-ROW read says (`GET /api/artifacts/{id}`) */
  row?: Partial<DataPlaneArtifact>
  /** make the reader fail, to exercise the degrade path */
  openFails?: Error
  /** extra non-raster rows, so the other catalog channels have something to report */
  others?: DataPlaneArtifact[]
  /** what `GET /api/artifacts/{id}` returns for a given id, when it must differ from the listing */
  fullRows?: Record<string, DataPlaneArtifact>
}

interface Probe {
  source: WorkbenchDataSource
  opens: { id: string; byteLength: number }[]
  rowReads: string[]
}

/** ONE spy for the whole file, installed per test.
 *
 *  It used to be installed inside `probe()`, which is a real trap worth leaving a note about:
 *  each `vi.spyOn` REPLACES the previous implementation, so in a case that builds two probes
 *  every warning landed in the second one's array and the assertion on the first read empty —
 *  a test that reported "the code did not warn" when the code warns fine. */
let warnings: unknown[][] = []
beforeEach(() => {
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

function probe(build: Build = {}): Probe {
  const listedRaster: DataPlaneArtifact = {
    id: 'r1',
    datatype: 'nobody/has-ever-registered-this',
    structure: HIRES.structure,
    meta: HIRES.meta,
    ...build.listed,
  }
  const fullRow: DataPlaneArtifact = {
    ...listedRaster,
    meta: HIRES.meta,
    stored_bytes: RASTER_BYTES.byteLength,
    ...build.row,
  }
  const artifacts = [listedRaster, ...(build.others ?? [])]

  const opens: { id: string; byteLength: number }[] = []
  const rowReads: string[] = []

  const deps: Partial<WorkbenchDataSourceDeps> = {
    getCatalog: async () => ({ axes: [], artifacts }),
    getArtifact: async id => {
      rowReads.push(id)
      if (id === listedRaster.id) return fullRow
      // A per-id FULL row, so a case can model the difference between what the LISTING carries and
      // what the artifact actually declares — which is the whole subject of TEST-12.
      const declared = build.fullRows?.[id]
      if (declared) return declared
      return artifacts.find(a => a.id === id) ?? { id, datatype: 'x/y' }
    },
    openPyramid: async (id, byteLength) => {
      opens.push({ id, byteLength })
      if (build.openFails) throw build.openFails
      return await realPyramid()
    },
    hasCapability: () => false,
  }
  return { source: new WorkbenchDataSource('p1', deps), opens, rowReads }
}

describe('TEST-13 — where the two facts come from, and how often the file is opened', () => {
  it('takes the byte length from the SINGLE-ROW read, not from the listing', async () => {
    // The listing row carries a WRONG length here and the single-row read carries the right
    // one. That is not a contrived split: the listing hop is also the one that would carry a
    // COMPACTED declaration, and the placement is a six-element array that compaction drops
    // entirely. Reading both from the row that carries them verbatim is the rule; this asserts
    // the code follows it, by making the two disagree and checking which one won.
    const { source, opens, rowReads } = probe({
      listed: { stored_bytes: 999 },
      row: { stored_bytes: RASTER_BYTES.byteLength },
    })

    await source.imagePixelSource()

    expect(rowReads, 'the single-row read happened').toContain('r1')
    expect(opens).toEqual([{ id: 'r1', byteLength: RASTER_BYTES.byteLength }])
  }, SLOW)

  it('refuses BY NAME for every unusable byte length — including the one that can actually occur', async () => {
    // A range reader cannot address the end of an object whose size it does not know, and both
    // ways to be wrong are silent from a rendered picture: an unclamped read of the last block
    // is a 416, and a length of 0 reads nothing at all.
    //
    // ZERO IS THE CASE THAT MATTERS. The guard was `=== undefined` for one round, which tested
    // only the value the wire type says cannot occur — `stored_bytes` is a required `number` on
    // both row types — while the field's OWN documentation says it is 0 for a gathered artifact,
    // which owns no blob. `0 ?? x` is `0`, so the reachable degenerate value walked straight
    // past the refusal named after it.
    for (const bad of [undefined, 0, -1, 1.5, Number.NaN]) {
      const { source, opens } = probe({
        listed: { stored_bytes: bad as number },
        row: { stored_bytes: bad as number },
      })
      await expect(source.imagePixelSource(), `stored_bytes = ${String(bad)}`).rejects.toThrow(
        /stored byte length/,
      )
      expect(opens, `the reader was never handed ${String(bad)}`).toEqual([])
    }
  })

  it('opens the file ONCE however many callers ask', async () => {
    // Two panes on one raster must not each re-open it, and `catalog()` shares the same opened
    // file rather than paying for a second one.
    const { source, opens } = probe()
    const [a, b] = await Promise.all([source.imagePixelSource(), source.imagePixelSource()])
    await source.catalog()
    await source.imageUnderlay()
    expect(opens.length, 'four callers, one open').toBe(1)
    expect(a).toBe(b)
  }, SLOW)

  it('a failed CONTROL-PLANE fetch is retried too — not just a failed open', async () => {
    // Found by a mutation that SURVIVED the first battery: removing the project-catalog memo's
    // drop-on-rejection turned nothing red. The retry above it was therefore untested in the one
    // direction that mattered — a rejected catalog promise is cached forever, so the raster
    // resolver's own retry runs straight back into it and can never recover.
    let catalogAttempts = 0
    const source = new WorkbenchDataSource('p1', {
      getCatalog: async () => {
        catalogAttempts += 1
        if (catalogAttempts === 1) throw new Error('the control plane blinked')
        return { axes: [], artifacts: [RASTER_ROW_FOR_RETRY] }
      },
      getArtifact: async () => RASTER_ROW_FOR_RETRY,
      openPyramid: async () => await realPyramid(),
      hasCapability: () => false,
    })

    await expect(source.imagePixelSource()).rejects.toThrow('the control plane blinked')
    // The SECOND call must reach the control plane again. A cached rejection is a failure that
    // outlives its cause.
    await expect(source.imagePixelSource()).resolves.toHaveLength(3)
    expect(catalogAttempts).toBe(2)
  }, SLOW)

  it('a FAILED open is retried rather than remembered as permanent', async () => {
    // A transient read error must not condemn the pane for the life of the tab. The memo is
    // dropped on failure, which is the same stance the streaming source takes on its catalog.
    let attempts = 0
    const deps: Partial<WorkbenchDataSourceDeps> = {
      getCatalog: async () => ({
        axes: [],
        artifacts: [
          {
            id: 'r1',
            datatype: 'nobody/has-ever-registered-this',
            structure: HIRES.structure,
            meta: HIRES.meta,
            stored_bytes: RASTER_BYTES.byteLength,
          },
        ],
      }),
      getArtifact: async id => ({
        id,
        datatype: 'nobody/has-ever-registered-this',
        structure: HIRES.structure,
        meta: HIRES.meta,
        stored_bytes: RASTER_BYTES.byteLength,
      }),
      openPyramid: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('transient')
        return await realPyramid()
      },
      hasCapability: () => false,
    }
    const source = new WorkbenchDataSource('p1', deps)
    await expect(source.imagePixelSource()).rejects.toThrow('transient')
    await expect(source.imagePixelSource()).resolves.toHaveLength(3)
    expect(attempts).toBe(2)
  }, SLOW)
})

describe('TEST-20 — a producer-declared display role outranks a bigger container', () => {
  it('prefers the raster the producer says is meant to be looked at', async () => {
    // The ambiguity this narrows: a SEGMENTATION LABEL raster declares byte-for-byte the same
    // container as a tissue image — opaque bytes, the same media type, one file — and the two
    // are distinguishable only by a datatype id this workspace may not read. Left on extent
    // alone, a project holding both would choose between a picture of tissue and a picture of
    // integer labels by artifact-id sort order.
    //
    // The producer does state something usable: its own `meta.role`. A display derivative
    // carries one; a label mask does not. So the roleless candidate loses EVEN THOUGH it
    // declares the larger extent — which is what makes this test about the rule and not about
    // the ordering it happens to agree with.
    const roleless: DataPlaneArtifact = {
      id: 'aaa-huge-but-roleless',
      datatype: 'nobody/has-ever-registered-this',
      structure: HIRES.structure,
      meta: { extent: { width: 9999, height: 9999 } },
      stored_bytes: RASTER_BYTES.byteLength,
    }
    const { source, opens } = probe({ others: [roleless] })
    expect((HIRES.meta as { role?: string }).role, 'the fixture really declares one').toBe('display')

    await source.catalog()
    expect(opens.map(o => o.id)).toEqual(['r1'])
  }, SLOW)

  it('falls back to extent when NEITHER declares a role — the preference is not a filter', async () => {
    // A raster whose producer declares no role is still renderable. Excluding it would trade a
    // hypothetical wrong picture for a certain absent one.
    const small: DataPlaneArtifact = {
      id: 'aaa-small',
      datatype: 'nobody/has-ever-registered-this',
      structure: HIRES.structure,
      meta: { extent: { width: 10, height: 10 } },
      stored_bytes: RASTER_BYTES.byteLength,
    }
    const big: DataPlaneArtifact = { ...small, id: 'zzz-big', meta: { extent: { width: 900, height: 900 } } }
    const { source, opens } = probe({ listed: small, others: [big] })
    await source.catalog()
    expect(opens.map(o => o.id)).toEqual(['zzz-big'])
  }, SLOW)
})

describe('TEST-14 — what the catalog says, and what it says when the raster will not open', () => {
  it('advertises the raster and describes exactly the texture it will serve', async () => {
    const { source } = probe()
    const catalog = await source.catalog()
    const underlay = await source.imageUnderlay()

    expect(catalog.hasImage).toBe(true)
    // The catalog's header and the served bytes must describe the SAME texture — the adapter
    // pairs one with the other, so a disagreement is a correctly-sized header over the wrong
    // buffer, which decodes into a sheared picture rather than an error.
    expect(catalog.image).toEqual({
      width: underlay.width,
      height: underlay.height,
      channels: underlay.channels,
      affine: underlay.affine,
      // #228 widened the header with the FRAME: the producer's `coordinate_space` id and the
      // FULL-RESOLUTION `to_space`. Both describe the same artifact as the four fields above and
      // ride out of the same call, so they belong to this exhaustive comparison rather than being
      // excluded from it — an exhaustive assertion that grows an exception is no longer exhaustive.
      // Note `affine` (space -> the SERVED level, 0.05) and `toSpace` (level 0 -> space, 5.0) are
      // reciprocal-and-scaled, not the same number.
      space: HIRES.meta.coordinate_space,
      toSpace: HIRES.meta.to_space,
    })
    expect(underlay.data.length).toBe(underlay.width * underlay.height * 4)
    // The COARSEST level, not the producer-declared full-resolution extent (1400x1800).
    expect([underlay.width, underlay.height]).toEqual([350, 450])
  }, SLOW)

  it('degrades to no-raster when the file will not open, and says why, and keeps the rest', async () => {
    // A listing cannot throw: one raster that will not open must not take the project's
    // layouts and columns with it. And a silently image-less project is indistinguishable
    // from one that has no image, so the reason has to be recoverable.
    const others: DataPlaneArtifact[] = [
      { id: 'c1', datatype: 'demo/column', structure: { encoding: 'zarr_v3', kind: 'table', arrays: [] } },
    ]
    const broken = probe({ openFails: new Error('the object store said no'), others })
    const healthy = probe({ others })

    const bad = await broken.source.catalog()
    const good = await healthy.source.catalog()

    expect(bad.hasImage).toBe(false)
    expect(bad.image).toBeUndefined()
    expect(
      warnings.some(w => String(w[0]).includes('raster skipped')),
      'the reason must be recoverable — a silently image-less project looks exactly like one ' +
        'that has no image',
    ).toBe(true)

    // Every OTHER channel is untouched by the raster failure.
    expect(bad.layouts).toEqual(good.layouts)
    expect(bad.valueColumns).toEqual(good.valueColumns)
    expect(bad.categoricalColumns).toEqual(good.categoricalColumns)
    expect(bad.continuousColumns).toEqual(good.continuousColumns)
    expect(bad.pointCount).toBe(good.pointCount)
  }, SLOW)

  it('a raster TOO LARGE for one texture is still advertised — the pyramid renders it', async () => {
    // ── THE REGRESSION THIS CASE EXISTS FOR ────────────────────────────────────────────────
    // The single-texture cap was added to stop a gigapixel raster being materialized, and the
    // first cut of it took the ONE case the tiling path exists for and made it unrenderable:
    // `catalog()` built `image` from the reduction, the reduction refused on size, `image`
    // stayed undefined, and `hasImage: image !== undefined` became FALSE — which withdraws the
    // raster view from the chart-type gate entirely. The repair disabled what it was protecting.
    //
    // `hasImage` and `image` answer two different questions: IS there a raster, and what is its
    // single-texture fallback. A raster too big for a fallback answers yes to the first and
    // nothing to the second.
    const huge = {
      pyramid: [{ labels: ['c', 'y', 'x'], shape: [1, 40_000, 40_000], dtype: 'Uint8' }],
      meta: {
        levels: [
          { path: '0', width: 40_000, height: 40_000, scale: [1, 1], translation: [0, 0], downsample: 1 },
        ],
        channels: [],
        dtype: 'Uint8',
        axisIndex: { y: 1, x: 2 },
      },
      interleaved: false,
      tiled: true,
      tileSize: 512,
    }
    const infos: unknown[][] = []
    const info = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      infos.push(args)
    })
    try {
      const source = new WorkbenchDataSource('p1', {
        getCatalog: async () => ({ axes: [], artifacts: [RASTER_ROW_FOR_RETRY] }),
        getArtifact: async () => RASTER_ROW_FOR_RETRY,
        openPyramid: async () => huge as never,
        hasCapability: () => false,
      })
      const catalog = await source.catalog()

      // OFFERED — the raster view must still be reachable for this project.
      expect(
        catalog.hasImage,
        'a raster too large for a fallback texture is exactly the raster the tiling path exists ' +
          'for; reporting no image withdraws the view from it',
      ).toBe(true)
      // …and NO single-texture header, because there is no single texture.
      expect(catalog.image).toBeUndefined()
      // …and the tiling seam still serves it.
      await expect(source.imagePixelSource()).resolves.toHaveLength(1)
      // …while the fallback refuses, by size, which is correct and is not an error.
      await expect(source.imageUnderlay()).rejects.toThrow(/single-texture cap/)
      // Reported at INFO, not as a failure: it explains the refusal without claiming a defect.
      expect(infos.some(i => String(i[0]).includes('too large for a single fallback'))).toBe(true)
    } finally {
      info.mockRestore()
    }
  })

  it('a project with no raster reports `hasImage: false` and carries no image block', async () => {
    const source = new WorkbenchDataSource('p1', {
      getCatalog: async () => ({
        axes: [],
        artifacts: [{ id: 'c1', datatype: 'demo/column', structure: { encoding: 'opaque', media_type: 'application/json' } }],
      }),
      getArtifact: async id => ({ id, datatype: 'demo/column' }),
      openPyramid: async () => {
        throw new Error('nothing here should open a reader')
      },
      hasCapability: () => false,
    })
    const catalog = await source.catalog()
    expect(catalog.hasImage).toBe(false)
    expect('image' in catalog, 'the key is ABSENT, not present-and-undefined').toBe(false)
    await expect(source.imageUnderlay()).rejects.toBeInstanceOf(NotReachableError)
  })
})

// ── #228 TEST-12 — the declaration is read off the row that CARRIES it ─────────────────────────

/**
 * The server's summary projection, reproduced faithfully from `dataset/models.rs`.
 *
 * `compact_declaration` (`:288`) keeps SCALAR-valued keys and SHORT ALL-SCALAR arrays, at most
 * `DECL_MAX_KEYS = 8` of them in KEY ORDER, with `DECL_MAX_ARRAY_ITEMS = 4`. Arrays are
 * "kept-or-dropped, never truncated" — which is precisely why a six-element `to_space` read off a
 * summary row arrives MISSING rather than short, and why a string `coordinate_space` does not.
 *
 * Reproduced rather than asserted-about, because the DISTINCTION between those two outcomes is
 * the load-bearing thing this branch relies on: it is what allows a layout's frame to ride the
 * catalog listing while the affine may not.
 */
function compacted(meta: Record<string, unknown>): Record<string, unknown> {
  const isScalar = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  const keep = Object.entries(meta).filter(([, v]) =>
    Array.isArray(v) ? v.length <= 4 && v.every(isScalar) : isScalar(v),
  )
  keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(keep.slice(0, 8))
}

describe('TEST-12 the coordinate_space and the placement come off the rows that carry them', () => {
  it('`image.toSpace` is the FULL row`s six-element affine, verbatim', async () => {
    const p = probe()
    const catalog = await p.source.catalog()
    expect(catalog.image?.toSpace).toEqual(HIRES.meta.to_space)
    expect(catalog.image?.toSpace).toHaveLength(6)
    expect(catalog.image?.space).toBe(HIRES.meta.coordinate_space)
  }, SLOW)

  it('a COMPACTED listing row keeps the space id and LOSES the affine — and the loss REFUSES', async () => {
    // The two halves of the same fact, on the same row, with different fates. This is the reason
    // `declaredSpace` may read a listing row and `declaredPlacement` may not, and it is asserted
    // rather than assumed.
    const short = compacted(HIRES.meta as unknown as Record<string, unknown>)
    expect(short.coordinate_space).toBe(HIRES.meta.coordinate_space)
    expect(short.to_space).toBeUndefined() // six elements > DECL_MAX_ARRAY_ITEMS

    // With the compacted meta on BOTH hops — i.e. a consumer that never fetched the full row —
    // the raster still OPENS (an absent placement is a fact about the artifact, not a producer
    // bug: `omeTiffUnderlay` renders it at array-index units and says so). What must NOT happen
    // is an overlay: the space id survived and the placement did not, so a consumer that bound on
    // the ids alone would draw points stated in the coordinate space over a raster sitting at
    // array-index units — a plausible wrong overlay assembled from HALF a declaration.
    //
    // THIS CASE FOUND A REAL DEFECT in the first cut of `resolveOverlayBinding`, which bound on
    // the two ids and nothing else. It is the reason that function takes `imagePlaced`.
    const p = probe({ listed: { meta: short }, row: { meta: short } })
    const catalog = await p.source.catalog()
    expect(catalog.image?.space).toBe(HIRES.meta.coordinate_space)
    expect(catalog.image?.toSpace).toBeUndefined()
    // array-index units at the served level: 1/2**2, never the declared 1/(5*4) = 0.05
    expect(catalog.image?.affine[0]).toBeCloseTo(0.25, 12)

    const { resolvePaneFrame } = await import('@txresbench/viz/core')
    const frame = resolvePaneFrame(
      { image: catalog.image!, layouts: [{ id: 'l', space: catalog.image!.space }] },
      'l',
    )
    expect(frame.binding.bound).toBe(false)
    expect(frame.binding.bound ? '' : frame.binding.reason).toContain('declares no to_space')
  }, SLOW)

  it('a SPATIAL layout`s frame comes off its FULL row, not off the mangled listing row', async () => {
    // ── WHY A FULL ROW, WHEN #159's DEC-3 BOUNDS `catalog()` ────────────────────────────────
    // The first cut of this read the frame off the LISTING row, on the premise that
    // `compact_declaration` caps only ARRAYS and so leaves a string id alone. That premise is
    // wrong in two ways it also keeps only the first `DECL_MAX_KEYS = 8` keys IN KEY ORDER, and
    // it truncates a string past `DECL_MAX_VALUE_CHARS = 120`. A MANGLED id is worse than a
    // missing one: it is a spurious refusal indistinguishable from two artifacts genuinely being
    // in different frames.
    //
    // So the FULL row is read, for the bounded set of artifacts that declare a spatial coordinate
    // capability — one on a Visium import. This case models both caps at once: the listing row is
    // compacted (its `to_space` gone) AND its id truncated, while the full row is intact.
    const SPACE = 'visium:Visium_Mouse_Olfactory_Bulb'
    const fullMeta = {
      coordinate_space: SPACE,
      unit: 'pixel',
      to_space: [1, 0, 0, 0, 1, 0],
      microns_per_pixel: 0.7471371402823337,
    }
    const listedMeta = { ...compacted(fullMeta), coordinate_space: `${SPACE.slice(0, 8)}` }
    const listed: DataPlaneArtifact = {
      id: 'coords-1',
      datatype: 'coords/type',
      structure: { encoding: 'zarr_v3', kind: 'table', axis: ENTITY_AXIS, n: 160 },
      meta: listedMeta,
    }
    const full: DataPlaneArtifact = { ...listed, meta: fullMeta }
    expect(
      (listedMeta as Record<string, unknown>).to_space,
      'the listing row really has lost the affine',
    ).toBeUndefined()
    expect(listedMeta.coordinate_space).not.toBe(SPACE)

    const p = probe({ others: [listed], fullRows: { 'coords-1': full } })
    ;(p.source as unknown as { deps: { hasCapability: unknown } }).deps.hasCapability = (
      dt: string,
      cap: string,
    ) => dt === 'coords/type' && (cap === 'plottable-xy' || cap === 'spatial-coordinates')

    const catalog = await p.source.catalog()
    const entry = catalog.layouts.find(l => l.id === 'coords-1')
    expect(entry?.space, 'the INTACT id, not the truncated one').toBe(SPACE)
    expect(entry?.toSpace, 'and the affine the listing row could not carry').toEqual([1, 0, 0, 0, 1, 0])
    // The extra reads are bounded by the SPATIAL artifacts, not by the layouts and not by the
    // artifacts: one raster row plus one coordinates row.
    expect(p.rowReads.sort()).toEqual(['coords-1', 'r1'])
  }, SLOW)

  it('a non-string `coordinate_space` is IGNORED, never coerced', async () => {
    // `String(undefined)` is `"undefined"`, so two artifacts that each stringify a missing key
    // would "agree" on a frame neither declared — a binding produced out of nothing.
    const p = probe({
      listed: { meta: { ...HIRES.meta, coordinate_space: 42 } },
      row: { meta: { ...HIRES.meta, coordinate_space: 42 } },
    })
    const catalog = await p.source.catalog()
    expect(catalog.image?.space).toBeUndefined()
    expect(catalog.image?.toSpace).toEqual(HIRES.meta.to_space) // the placement is unaffected
  }, SLOW)
})

// ── #228 TEST-38 — the spatial-frame memo does not remember a failure ───────────────────────

describe('TEST-38 a transient frame read is retried, not condemned', () => {
  it('a rejection is dropped from the memo, so the next `catalog()` re-reads', async () => {
    // The memo exists because `catalog()` is NOT itself memoized and has many callers, so an
    // un-cached read would pay its round trips per CALL. A memo that REMEMBERED a rejection would
    // be worse than none: one blinked control-plane request and the project's frames are gone for
    // the life of the tab, and every spatial pane silently refuses forever. It is the same stance
    // `projectCatalog` and `resolveRaster` take, and the rule was unasserted.
    const layoutRow: DataPlaneArtifact = {
      id: 'coords-1',
      datatype: 'coords/type',
      structure: { encoding: 'zarr_v3', kind: 'table', axis: ENTITY_AXIS, n: 160 },
      meta: { coordinate_space: 'visium:Visium_Mouse_Olfactory_Bulb', to_space: [1, 0, 0, 0, 1, 0] },
    }
    let blink = true
    const p = probe({ others: [layoutRow] })
    ;(p.source as unknown as { deps: { hasCapability: unknown; getArtifact: unknown } }).deps.hasCapability =
      (dt: string, cap: string) =>
        dt === 'coords/type' && (cap === 'plottable-xy' || cap === 'spatial-coordinates')
    const inner = (p.source as unknown as { deps: { getArtifact: (id: string) => Promise<DataPlaneArtifact> } }).deps
      .getArtifact
    ;(p.source as unknown as { deps: { getArtifact: unknown } }).deps.getArtifact = async (id: string) => {
      if (id === layoutRow.id && blink) {
        blink = false
        throw new Error('the control plane blinked')
      }
      return inner(id)
    }

    // FIRST call: the row read fails. It degrades — a listing may not take the project's layouts
    // down for one artifact — so the layout is offered with NO frame, which is a refusal.
    const first = await p.source.catalog()
    expect(first.layouts.find(l => l.id === layoutRow.id)?.space).toBeUndefined()

    // SECOND call: the memo did not keep the failure, so the frame arrives.
    const second = await p.source.catalog()
    expect(second.layouts.find(l => l.id === layoutRow.id)?.space).toBe(
      'visium:Visium_Mouse_Olfactory_Bulb',
    )
  }, SLOW)
})

// ── #228 TEST-44 — the memo is real, and it is bounded ──────────────────────────────────────

describe('TEST-44 the spatial-frame reads are paid once per project, not once per catalog() call', () => {
  it('two `catalog()` calls issue the SAME row reads as one', async () => {
    // `catalog()` is not itself memoized and has many callers, so an un-cached frame read pays its
    // round trips per CALL. Removing the memo entirely left every other assertion green — the
    // rejection test above needs the read to happen at all, not to happen once — so the memo's
    // existence had no coverage. Counted rather than asserted about: two calls, two row reads.
    const layoutRow: DataPlaneArtifact = {
      id: 'coords-1',
      datatype: 'coords/type',
      structure: { encoding: 'zarr_v3', kind: 'table', axis: ENTITY_AXIS, n: 160 },
      meta: { coordinate_space: 'visium:Visium_Mouse_Olfactory_Bulb', to_space: [1, 0, 0, 0, 1, 0] },
    }
    const p = probe({ others: [layoutRow] })
    ;(p.source as unknown as { deps: { hasCapability: unknown } }).deps.hasCapability = (
      dt: string,
      cap: string,
    ) => dt === 'coords/type' && (cap === 'plottable-xy' || cap === 'spatial-coordinates')

    await p.source.catalog()
    const afterFirst = [...p.rowReads].sort()
    await p.source.catalog()
    expect(afterFirst).toEqual(['coords-1', 'r1'])
    expect([...p.rowReads].sort(), 'the second call re-read nothing').toEqual(afterFirst)
  }, SLOW)
})
